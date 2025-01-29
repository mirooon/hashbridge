import { mempoolTxUrl, suiscanTxUrl } from '@hashbridge/core/links';
import type { RecoveryFile, SwapView, Utxo } from '@hashbridge/core/types';

export const CLAIM_FALLBACK_MS = 30_000;
export const MIN_REMAINING_BEFORE_REVEAL_MS = 10 * 60_000;

export type ClaimAction =
  | { kind: 'wait' }
  | { kind: 'verify-and-claim'; htlcObjectId: string }
  | { kind: 'show-fallback' }
  | { kind: 'done' };

export function nextClaimAction(view: SwapView | null, claimSentAt: number | null, now: number): ClaimAction {
  if (!view) return { kind: 'wait' };
  if (view.status === 'SUI_CLAIMED' || view.status === 'BTC_CLAIMED') return { kind: 'done' };
  if (view.status !== 'SUI_LOCKED' || !view.htlcObjectId) return { kind: 'wait' };
  if (claimSentAt === null) return { kind: 'verify-and-claim', htlcObjectId: view.htlcObjectId };
  return now - claimSentAt >= CLAIM_FALLBACK_MS ? { kind: 'show-fallback' } : { kind: 'wait' };
}

/** The quote scaled to what was actually paid, never above the original quote. */
export function minExpectedMist(recovery: RecoveryFile, depositSats: number): bigint {
  const paid = BigInt(Math.min(depositSats, recovery.btcSats));
  return (BigInt(recovery.suiAmount) * paid) / BigInt(recovery.btcSats);
}

/**
 * Sats actually paid to the HTLC address. When the chain's UTXOs are given they are the only
 * source (independent of the bot); otherwise fall back to the bot-reported deposit.
 * Returns null when the amount is unknown or zero, so the caller must refuse to reveal the secret.
 */
export function paidSatsFrom(utxos: Utxo[] | null, depositSats: number | null): number | null {
  const paid = utxos === null ? depositSats : utxos.reduce((sum, u) => sum + u.value, 0);
  return paid !== null && Number.isFinite(paid) && paid > 0 ? paid : null;
}

export interface TimelineItem {
  chain: 'btc' | 'sui';
  label: string;
  state: 'done' | 'active' | 'pending';
  href: string | null;
}

export function timelineItems(view: SwapView): TimelineItem[] {
  const steps: Array<Omit<TimelineItem, 'state'> & { done: boolean }> = [
    { chain: 'btc', label: 'Deposit in mempool', done: view.depositTxid !== null, href: view.depositTxid ? mempoolTxUrl(view.depositTxid) : null },
    { chain: 'sui', label: 'SUI locked by the bot', done: view.lockDigest !== null, href: view.lockDigest ? suiscanTxUrl(view.lockDigest) : null },
    { chain: 'sui', label: 'Secret revealed, SUI received', done: view.claimDigest !== null, href: view.claimDigest ? suiscanTxUrl(view.claimDigest) : null },
    { chain: 'btc', label: 'Bot claimed the BTC', done: view.status === 'BTC_CLAIMED', href: view.btcClaimTxid ? mempoolTxUrl(view.btcClaimTxid) : null },
  ];
  const firstPending = steps.findIndex((s) => !s.done);
  return steps.map(({ done, ...item }, i) => ({ ...item, state: done ? 'done' : i === firstPending ? 'active' : 'pending' }));
}
