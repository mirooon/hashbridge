import { useEffect, useRef, useState } from 'react';
import type { BtcChain, RecoveryFile, SwapView, Utxo } from '@hashbridge/core/types';
import type { HashbridgeApi } from '../lib/api';
import { MIN_REMAINING_BEFORE_REVEAL_MS, minExpectedMist, nextClaimAction, paidSatsFrom } from '../lib/claim-flow';
import type { SwapStorage } from '../lib/storage';
import { verifyHtlc, type HtlcReader } from '../lib/sui-verify';
import { useNow } from './useNow';

export const POLL_MS = 2_000;

export interface SwapProgress {
  view: SwapView | null;
  apiError: string | null;
  lastApiOkAt: number | null;
  problems: string[];
  claimError: string | null;
  fallback: boolean;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function useSwapProgress(opts: {
  api: HashbridgeApi;
  storage: SwapStorage;
  htlcReader: HtlcReader;
  packageId: string;
  recovery: RecoveryFile;
  /** When given, the paid amount is read from the Bitcoin chain instead of trusting the bot's report. */
  esplora?: BtcChain;
}): SwapProgress {
  const { api, storage, htlcReader, packageId, recovery, esplora } = opts;
  const [view, setView] = useState<SwapView | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [lastApiOkAt, setLastApiOkAt] = useState<number | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [fallback, setFallback] = useState(false);
  const now = useNow(1_000);
  const busy = useRef(false);
  const lastAttemptAt = useRef(0);
  // undefined = not read from storage yet; once set (number or null) the ref is authoritative,
  // so a storage that silently fails to persist cannot re-trigger or block the reveal.
  const claimSentAtRef = useRef<number | null | undefined>(undefined);

  useEffect(() => {
    claimSentAtRef.current = undefined;
  }, [recovery.swapId]);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const next = await api.getSwap(recovery.swapId);
        if (cancelled) return;
        setView(next);
        setApiError(null);
        setLastApiOkAt(Date.now());
      } catch (err) {
        if (!cancelled) setApiError(message(err));
      }
    };
    void poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [api, recovery.swapId]);

  useEffect(() => {
    const claimSentAt =
      claimSentAtRef.current !== undefined ? claimSentAtRef.current : (storage.load(recovery.swapId)?.claimSentAt ?? null);
    const action = nextClaimAction(view, claimSentAt, now);
    setFallback(action.kind === 'show-fallback');
    if (action.kind !== 'verify-and-claim' || busy.current || !view) return;
    // The tick re-runs this effect every second: retry a failed check or claim at most once per poll interval.
    if (now - lastAttemptAt.current < POLL_MS) return;
    lastAttemptAt.current = now;
    busy.current = true;

    const verify = async (): Promise<string[]> => {
      let htlc;
      try {
        htlc = await htlcReader.fetchHtlc(action.htlcObjectId);
      } catch (err) {
        return [`could not read the HTLC from Sui: ${message(err)}`];
      }
      if (!htlc) return ['HTLC object not found on Sui'];
      let utxos: Utxo[] | null = null;
      if (esplora) {
        try {
          utxos = await esplora.addressUtxos(recovery.htlcAddress);
        } catch (err) {
          return [`could not read the deposit from Bitcoin: ${message(err)}`];
        }
      }
      const paidSats = paidSatsFrom(utxos, view.depositSats);
      const found = verifyHtlc(htlc, {
        packageId,
        recipient: recovery.suiRecipient,
        hash: recovery.hash,
        minAmountMist: paidSats === null ? 0n : minExpectedMist(recovery, paidSats),
        nowMs: Date.now(),
        minRemainingMs: MIN_REMAINING_BEFORE_REVEAL_MS,
      });
      if (paidSats === null) found.push('deposit amount could not be verified');
      return found;
    };

    (async () => {
      let found: string[];
      try {
        found = await verify();
      } catch (err) {
        found = [`verification failed: ${message(err)}`];
      }
      setProblems(found);
      if (found.length > 0) return;
      const sentAt = Date.now();
      claimSentAtRef.current = sentAt;
      storage.update(recovery.swapId, { claimSentAt: sentAt });
      try {
        await api.claim(recovery.swapId, recovery.secret);
        setClaimError(null);
      } catch (err) {
        // The bot's claim endpoint is idempotent: forget the attempt so the next tick re-verifies and re-sends.
        claimSentAtRef.current = null;
        storage.update(recovery.swapId, { claimSentAt: null });
        setClaimError(message(err));
      }
    })().finally(() => {
      busy.current = false;
    });
  }, [view, now, api, storage, htlcReader, packageId, recovery, esplora]);

  return { view, apiError, lastApiOkAt, problems, claimError, fallback };
}
