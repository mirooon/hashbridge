import { useEffect, useState } from 'react';
import { mempoolTxUrl } from '@hashbridge/core/links';
import type { BtcChain, RecoveryFile } from '@hashbridge/core/types';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { ExplorerLink } from '../components/ExplorerLink';
import { shortHex } from '../lib/format';
import { blocksUntilRefund, executeRefund } from '../lib/refund';

export function RefundStep({
  recovery,
  esplora,
  reason,
  onBack,
}: {
  recovery: RecoveryFile;
  esplora: BtcChain;
  reason?: string | null;
  onBack?: () => void;
}) {
  const [tip, setTip] = useState<number | null>(null);
  const [destination, setDestination] = useState('');
  const [txid, setTxid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      esplora
        .tipHeight()
        .then((h) => {
          if (!cancelled) setTip(h);
        })
        .catch(() => undefined);
    void load();
    const id = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [esplora]);

  const remaining = tip === null ? null : blocksUntilRefund(recovery.locktime, tip);

  async function refund() {
    setBusy(true);
    setError(null);
    try {
      setTxid((await executeRefund(recovery, destination.trim(), esplora)).txid);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Refund your BTC">
      {reason && <p className="mb-4 rounded-xl bg-slate-800 px-4 py-3 text-sm text-slate-300">The bot did not complete this swap: {reason}.</p>}
      <p className="text-sm text-slate-300">
        Your BTC stays locked until block {recovery.locktime.toLocaleString('en-US')}. After that, only your refund key can move it.
      </p>
      <p className="mt-2 text-sm text-slate-400">
        {remaining === null
          ? 'Checking the block height…'
          : remaining > 0
            ? `Refund available in ${remaining} blocks (about ${remaining * 10} min).`
            : 'Refund is available now.'}
      </p>
      <label className="mt-4 block">
        <span className="text-sm text-slate-400">Your BTC address (signet)</span>
        <input
          value={destination}
          onChange={(e) => setDestination(e.target.value)}
          placeholder="tb1…"
          className="mt-1 w-full rounded-xl bg-slate-800 px-4 py-3 font-mono text-sm text-slate-100 outline-none focus:ring-2 focus:ring-amber-400"
        />
      </label>
      {error && <p className="mt-4 rounded-xl bg-red-950 px-4 py-3 text-sm text-red-300">{error}</p>}
      {txid ? (
        <p className="mt-4 text-sm text-emerald-400">
          Refund sent: <ExplorerLink href={mempoolTxUrl(txid)}>{shortHex(txid)}</ExplorerLink>
        </p>
      ) : (
        <Button className="mt-4" disabled={busy || remaining !== 0 || destination.trim() === ''} onClick={refund}>
          {busy ? 'Broadcasting…' : 'Refund BTC'}
        </Button>
      )}
      {onBack && (
        <button type="button" onClick={onBack} className="mt-6 block text-sm text-slate-400 hover:underline">
          Back to the swap
        </button>
      )}
    </Card>
  );
}
