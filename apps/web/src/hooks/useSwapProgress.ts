import { useEffect, useRef, useState } from 'react';
import type { BtcChain, RecoveryFile, SwapView, Utxo } from '@hashbridge/core/types';
import type { HashbridgeApi } from '../lib/api';
import {
  chainExists,
  chainWatch,
  nextChainReading,
  nextClaimAction,
  postRevealState,
  revealProblems,
  shouldResendClaim,
  type ChainReading,
  type ChainWatch,
} from '../lib/claim-flow';
import type { LocalSwapState, SwapStorage } from '../lib/storage';
import type { HtlcReader } from '../lib/sui-verify';
import { useNow } from './useNow';

export const POLL_MS = 2_000;

export interface SwapProgress {
  view: SwapView | null;
  apiError: string | null;
  lastApiOkAt: number | null;
  /** Why the secret was not revealed (only before the reveal). */
  problems: string[];
  claimError: string | null;
  /** The secret was sent to the bot, in this session or an earlier one. */
  revealed: boolean;
  /** No claim on-chain 30 s after the reveal: offer "Claim myself". */
  fallback: boolean;
  /** The HTLC object is gone from Sui, i.e. the claim landed (read from the chain, not from the bot). */
  claimedOnChain: boolean;
  /** HTLC to claim: the one verified before the reveal, else the one the bot reports. */
  htlcObjectId: string | null;
}

interface Reveal {
  at: number;
  htlcObjectId: string | null;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function revealOf(state: LocalSwapState | null): Reveal | null {
  return state && state.revealedAt !== null ? { at: state.revealedAt, htlcObjectId: state.revealedHtlcId } : null;
}

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
  const [reveal, setReveal] = useState<Reveal | null>(null);
  const [reading, setReading] = useState<ChainReading | null>(null);
  const now = useNow(1_000);
  const verifyBusy = useRef(false);
  const lastVerifyAt = useRef(0);
  const claimBusy = useRef(false);
  const lastClaimAt = useRef(0);
  const claimAccepted = useRef(false);
  const readBusy = useRef(false);
  const lastReadAt = useRef(0);
  // The reveal marker is read from storage once per swap and then kept here, so a storage that silently fails to
  // persist can neither re-trigger the reveal nor make the browser forget that the secret is out.
  const revealRef = useRef<{ swapId: string; value: Reveal | null } | null>(null);
  // The watch in force when a chain read returns; reads of anything else are dropped (see nextChainReading).
  const watchRef = useRef<ChainWatch | null>(null);

  useEffect(() => {
    setReading(null);
    claimAccepted.current = false;
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
    if (revealRef.current?.swapId !== recovery.swapId) {
      revealRef.current = { swapId: recovery.swapId, value: revealOf(storage.load(recovery.swapId)) };
    }
    const current = revealRef.current.value;
    setReveal(current);
    const revealedAt = current?.at ?? null;
    const watch = chainWatch(current, view);
    watchRef.current = watch;

    // The chain, not the bot, tells whether the claim landed: a claim deletes the Htlc object.
    if (watch && chainExists(reading, watch) !== false && !readBusy.current && now - lastReadAt.current >= POLL_MS) {
      lastReadAt.current = now;
      readBusy.current = true;
      const { id } = watch;
      const at = Date.now();
      const record = (exists: boolean | null) => setReading((prev) => nextChainReading(prev, { id, exists, at }, watchRef.current));
      htlcReader
        .fetchHtlc(id)
        .then(
          (htlc) => record(htlc !== null),
          () => record(null),
        )
        .finally(() => {
          readBusy.current = false;
        });
    }

    const sendClaim = (at: number) => {
      lastClaimAt.current = at;
      claimBusy.current = true;
      api
        .claim(recovery.swapId, recovery.secret)
        .then(
          () => {
            claimAccepted.current = true;
            setClaimError(null);
          },
          // The secret is out either way; the request is repeated while the claim is not on-chain (the endpoint is idempotent).
          (err) => setClaimError(message(err)),
        )
        .finally(() => {
          claimBusy.current = false;
        });
    };

    const state = postRevealState({ revealedAt, now, reading, watch });
    if (!claimBusy.current && shouldResendClaim({ revealedAt, claimAccepted: claimAccepted.current, state, now, lastAttemptAt: lastClaimAt.current })) {
      sendClaim(now);
      return;
    }

    const action = nextClaimAction(view, revealedAt);
    if (action.kind !== 'verify-and-claim' || verifyBusy.current || !view) return;
    // The tick re-runs this effect every second: retry a failed check at most once per poll interval.
    if (now - lastVerifyAt.current < POLL_MS) return;
    lastVerifyAt.current = now;
    verifyBusy.current = true;

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
      return revealProblems({ htlc, utxos, botDepositSats: view.depositSats, recovery, packageId, nowMs: Date.now() });
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
      // Mark the reveal before the secret leaves the browser, so a crash or reload never treats it as unrevealed.
      const revealed: Reveal = { at: Date.now(), htlcObjectId: action.htlcObjectId };
      revealRef.current = { swapId: recovery.swapId, value: revealed };
      storage.update(recovery.swapId, { revealedAt: revealed.at, revealedHtlcId: revealed.htlcObjectId });
      // From now on only readings of the verified HTLC taken after the reveal count.
      watchRef.current = chainWatch(revealed, view);
      setReading(null);
      setReveal(revealed);
      sendClaim(revealed.at);
    })().finally(() => {
      verifyBusy.current = false;
    });
  }, [view, now, api, storage, htlcReader, packageId, recovery, esplora, reading]);

  const state = postRevealState({ revealedAt: reveal?.at ?? null, now, reading, watch: chainWatch(reveal, view) });
  return {
    view,
    apiError,
    lastApiOkAt,
    problems: reveal ? [] : problems,
    claimError,
    revealed: reveal !== null,
    fallback: state === 'show-fallback',
    claimedOnChain: state === 'claimed-on-chain',
    htlcObjectId: reveal?.htlcObjectId ?? view?.htlcObjectId ?? null,
  };
}
