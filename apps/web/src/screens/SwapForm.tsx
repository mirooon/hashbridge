import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { quoteMist } from '@hashbridge/core/pricing';
import type { BtcChain, HealthResponse } from '@hashbridge/core/types';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { Countdown } from '../components/Countdown';
import type { HashbridgeApi } from '../lib/api';
import { formatBtc, formatSui, parseBtcToSats } from '../lib/format';
import { buildRecovery, parseSuiAddress, prepareSwap, quoteProblems, verifyBotResponse } from '../lib/new-swap';
import type { LocalSwapState } from '../lib/storage';

const RATE_REFRESH_MS = 30_000;
const INPUT = 'w-full rounded-xl bg-slate-800 px-4 py-3 text-slate-100 outline-none focus:ring-2 focus:ring-amber-400';

export interface SwapFormProps {
  api: HashbridgeApi;
  esplora: BtcChain;
  apiUrl: string;
  walletAddress?: string | null;
  walletSlot?: ReactNode;
  onCreated(state: LocalSwapState): void;
}

export function SwapForm({ api, esplora, apiUrl, walletAddress, walletSlot, onCreated }: SwapFormProps) {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [nextRefreshAt, setNextRefreshAt] = useState(() => Date.now() + RATE_REFRESH_MS);
  const [amount, setAmount] = useState('0.001');
  const [address, setAddress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (walletAddress) setAddress(walletAddress);
  }, [walletAddress]);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .health()
        .then((h) => {
          if (cancelled) return;
          setHealth(h);
          setNextRefreshAt(Date.now() + RATE_REFRESH_MS);
        })
        .catch((e: Error) => {
          if (!cancelled) setError(e.message);
        });
    void load();
    const id = setInterval(load, RATE_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [api]);

  const sats = parseBtcToSats(amount);
  const estimate = health && sats !== null ? quoteMist(sats, health.rate, health.spreadBps) : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const suiRecipient = parseSuiAddress(address);
    if (sats === null) return setError('Enter a valid BTC amount.');
    if (health && (sats < health.minBtcSats || sats > health.maxBtcSats)) {
      return setError(`Amount must be between ${formatBtc(health.minBtcSats)} and ${formatBtc(health.maxBtcSats)} BTC.`);
    }
    if (!suiRecipient) return setError('Enter a valid Sui address (0x followed by 64 hex characters).');
    setBusy(true);
    try {
      const prep = prepareSwap();
      const req = { hash: prep.hash, refundPubkey: prep.refundPubkey, suiRecipient, btcSats: sats };
      const res = await api.createSwap(req);
      const tip = await esplora.tipHeight();
      // The binding quote is checked against the rate this form displayed.
      const problems = [...verifyBotResponse(prep, res, tip), ...quoteProblems(res.suiAmount, sats, health)];
      if (problems.length > 0) {
        setError(`Safety check failed: ${problems.join('; ')}. Do not pay.`);
        return;
      }
      onCreated({
        recovery: buildRecovery(prep, req, res, apiUrl, Date.now()),
        recoveryDownloaded: false,
        revealedAt: null,
        revealedHtlcId: null,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Swap BTC → SUI">
      <form onSubmit={submit} className="space-y-4">
        <label className="block">
          <span className="text-sm text-slate-400">You send (BTC, signet)</span>
          <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" className={`mt-1 font-mono text-lg ${INPUT}`} />
        </label>
        <div className="rounded-xl bg-slate-800/50 px-4 py-3">
          <div className="text-sm text-slate-400">You get (SUI, testnet)</div>
          <div className="font-mono text-lg text-slate-100">{estimate !== null ? `≈ ${formatSui(estimate)} SUI` : '—'}</div>
          {health && (
            <div className="mt-1 text-xs text-slate-500">
              1 BTC = {health.rate.toLocaleString('en-US')} SUI · fee {health.spreadBps / 100}% · rate refreshes in{' '}
              <Countdown targetMs={nextRefreshAt} />
            </div>
          )}
        </div>
        <label className="block">
          <span className="text-sm text-slate-400">Your Sui address</span>
          <div className="mt-1 flex gap-2">
            <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="0x…" className={`font-mono text-sm ${INPUT}`} />
            {walletSlot}
          </div>
        </label>
        {error && <p className="rounded-xl bg-red-950 px-4 py-3 text-sm text-red-300">{error}</p>}
        <Button type="submit" disabled={busy} className="w-full">
          {busy ? 'Creating swap…' : 'Start swap'}
        </Button>
      </form>
    </Card>
  );
}
