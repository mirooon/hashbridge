import type { ReactNode } from 'react';
import type { RecoveryFile } from '@hashbridge/core/types';
import { Card } from '../components/Card';
import { Countdown } from '../components/Countdown';
import { ExplorerLink } from '../components/ExplorerLink';
import type { SwapProgress } from '../hooks/useSwapProgress';
import { timelineItems, type TimelineItem } from '../lib/claim-flow';

const DOT: Record<TimelineItem['state'], string> = {
  done: 'bg-emerald-400',
  active: 'bg-amber-400 animate-pulse',
  pending: 'bg-slate-600',
};

function Column({ title, items }: { title: string; items: TimelineItem[] }) {
  return (
    <div className="flex-1">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">{title}</h3>
      <ol className="space-y-3">
        {items.map((item) => (
          <li key={item.label} className="flex items-center gap-3">
            <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${DOT[item.state]}`} />
            <span className={item.state === 'pending' ? 'text-slate-500' : 'text-slate-200'}>{item.label}</span>
            {item.href && <ExplorerLink href={item.href}>↗</ExplorerLink>}
          </li>
        ))}
      </ol>
    </div>
  );
}

export function TimelineStep({
  recovery,
  progress,
  fallbackSlot,
  onRefundOptions,
}: {
  recovery: RecoveryFile;
  progress: SwapProgress;
  fallbackSlot?: ReactNode;
  onRefundOptions?: () => void;
}) {
  const items = progress.view ? timelineItems(progress.view) : [];
  return (
    <Card title="Swap in progress">
      <div className="flex flex-col gap-6 sm:flex-row">
        <Column title="Bitcoin (signet)" items={items.filter((i) => i.chain === 'btc')} />
        <Column title="Sui (testnet)" items={items.filter((i) => i.chain === 'sui')} />
      </div>
      <div className="mt-6 flex flex-wrap justify-between gap-2 text-xs text-slate-500">
        <span>BTC refund possible from block {recovery.locktime.toLocaleString('en-US')}</span>
        {progress.view?.suiDeadlineMs && (
          <span>
            Sui deadline in <Countdown targetMs={progress.view.suiDeadlineMs} />
          </span>
        )}
      </div>
      {/* Before the reveal only: once the secret is out, "not revealed" would be a lie. */}
      {!progress.revealed && progress.problems.length > 0 && (
        <div className="mt-4 rounded-xl bg-red-950 px-4 py-3 text-sm text-red-300">
          Safety check failed, your secret was NOT revealed:
          <ul className="mt-1 list-disc pl-5">
            {progress.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      {progress.revealed && !progress.claimedOnChain && !progress.fallback && (
        <p className="mt-4 text-sm text-slate-400">Secret revealed. Waiting for the claim to appear on Sui…</p>
      )}
      {progress.claimedOnChain && (
        <p className="mt-4 text-sm text-emerald-400">The HTLC is gone from Sui: your claim went through. Waiting for the bot to update.</p>
      )}
      {progress.claimError && !progress.claimedOnChain && (
        <p className="mt-4 text-sm text-red-300">Claim request failed: {progress.claimError}. Retrying…</p>
      )}
      {progress.fallback && (
        <div className="mt-4 rounded-xl bg-amber-950 px-4 py-3 text-sm text-amber-200">
          Your claim is not on Sui yet, 30 seconds after your secret was revealed. You can claim the SUI yourself with a wallet
          that holds a little SUI for gas.
          {fallbackSlot && <div className="mt-3">{fallbackSlot}</div>}
        </div>
      )}
      {progress.apiError && <p className="mt-4 text-xs text-slate-500">Bot unreachable: {progress.apiError}</p>}
      {onRefundOptions && (
        <button type="button" onClick={onRefundOptions} className="mt-6 text-sm text-slate-400 hover:underline">
          Having trouble? Refund options
        </button>
      )}
    </Card>
  );
}
