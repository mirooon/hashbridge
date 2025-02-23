import { useState } from 'react';
import { witnessScriptAsm } from '@hashbridge/core/htlc-script';
import { hexToBytes } from '@hashbridge/core/secret';
import type { RecoveryFile, SwapView } from '@hashbridge/core/types';
import { Card } from '../components/Card';
import { CopyField } from '../components/CopyField';
import { Countdown } from '../components/Countdown';
import { QrCode } from '../components/QrCode';
import { useNow } from '../hooks/useNow';
import { formatBtc, formatSui } from '../lib/format';

export function DepositStep({ recovery, view }: { recovery: RecoveryFile; view: SwapView | null }) {
  const now = useNow(1000);
  const [showScript, setShowScript] = useState(false);
  const amount = formatBtc(recovery.btcSats);
  const expired = now > recovery.quoteExpiresAt;
  const asm = witnessScriptAsm(hexToBytes(recovery.witnessScript)).split(' OP_').join('\nOP_');

  return (
    <Card title="Send BTC to the HTLC address">
      {expired ? (
        <p className="mb-4 rounded-xl bg-red-950 px-4 py-3 text-sm text-red-300">
          This quote expired. Do not send BTC, start a new swap instead. If you already paid, wait for the refund option.
        </p>
      ) : (
        <p className="mb-4 text-sm text-slate-400">
          Pay within <Countdown targetMs={recovery.quoteExpiresAt} /> to keep this rate.
        </p>
      )}
      <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-start">
        <QrCode value={`bitcoin:${recovery.htlcAddress}?amount=${amount}`} />
        <div className="w-full min-w-0 space-y-3">
          <CopyField label="Address" value={recovery.htlcAddress} mono />
          <CopyField label="Amount (BTC)" value={amount} mono />
          <p className="text-sm text-slate-300">You receive ≈ {formatSui(recovery.suiAmount)} SUI</p>
          <p className="text-sm text-slate-400">{view ? 'Waiting for your deposit…' : 'Connecting to the bot…'}</p>
        </div>
      </div>
      <button type="button" className="mt-6 text-sm text-amber-400 hover:underline" onClick={() => setShowScript((s) => !s)}>
        {showScript ? 'Hide HTLC script' : 'Show HTLC script'}
      </button>
      {showScript && (
        <pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-all rounded-xl bg-slate-950 p-4 font-mono text-xs text-slate-300">{asm}</pre>
      )}
    </Card>
  );
}
