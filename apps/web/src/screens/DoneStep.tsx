import { mempoolTxUrl, suiscanTxUrl } from '@hashbridge/core/links';
import type { SwapView } from '@hashbridge/core/types';
import { Card } from '../components/Card';
import { ExplorerLink } from '../components/ExplorerLink';
import { formatSui, shortHex } from '../lib/format';

export function DoneStep({ view }: { view: SwapView }) {
  return (
    <Card title="Swap complete">
      <p className="text-3xl font-semibold text-emerald-400">{formatSui(view.suiAmount)} SUI</p>
      <p className="mt-1 text-sm text-slate-400">sent to {shortHex(view.suiRecipient)}</p>
      <ul className="mt-6 space-y-2 text-sm text-slate-300">
        {view.depositTxid && (
          <li>
            Your BTC deposit: <ExplorerLink href={mempoolTxUrl(view.depositTxid)}>{shortHex(view.depositTxid)}</ExplorerLink>
          </li>
        )}
        {view.claimDigest && (
          <li>
            Your SUI claim: <ExplorerLink href={suiscanTxUrl(view.claimDigest)}>{shortHex(view.claimDigest)}</ExplorerLink>
          </li>
        )}
        {view.btcClaimTxid && (
          <li>
            Bot&apos;s BTC claim: <ExplorerLink href={mempoolTxUrl(view.btcClaimTxid)}>{shortHex(view.btcClaimTxid)}</ExplorerLink>
          </li>
        )}
      </ul>
      <p className="mt-6 text-sm text-slate-400">
        The bot could only take your BTC with the secret you revealed when claiming your SUI. Until then, each side could only get
        its own funds back.
      </p>
    </Card>
  );
}
