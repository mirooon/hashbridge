import { mempoolTxUrl, suiscanTxUrl } from '@hashbridge/core/links';
import type { RecoveryFile, SwapView, Utxo } from '@hashbridge/core/types';
import { verifyHtlc, type HtlcOnChain } from './sui-verify';

export const CLAIM_FALLBACK_MS = 30_000;
export const MIN_REMAINING_BEFORE_REVEAL_MS = 10 * 60_000;
/** After the reveal a failed claim request is re-sent at most this often (the bot's claim endpoint is idempotent). */
export const CLAIM_RETRY_MS = 2_000;

export const SPLIT_DEPOSIT_PROBLEM =
  'you paid in several parts; the bot locked SUI for the first payment only — refund after the locktime';

/** Before the reveal: verify the HTLC, then send the secret. Nothing is verified or revealed twice. */
export type ClaimAction = { kind: 'wait' } | { kind: 'verify-and-claim'; htlcObjectId: string };

export function nextClaimAction(view: SwapView | null, revealedAt: number | null): ClaimAction {
  if (revealedAt !== null || !view || view.status !== 'SUI_LOCKED' || !view.htlcObjectId) return { kind: 'wait' };
  return { kind: 'verify-and-claim', htlcObjectId: view.htlcObjectId };
}

export type PostRevealState = 'waiting' | 'show-fallback' | 'claimed-on-chain';

/** Two null reads of the watched object this far apart confirm it is gone (covers GraphQL replicas that lag). */
export const CHAIN_CONFIRM_MS = 2_000;

/** The Htlc object whose presence on Sui the browser checks, and from when readings count. */
export interface ChainWatch {
  id: string;
  /** Readings taken at or before this time do not count: the reveal time after a reveal, 0 before it. */
  since: number;
}

/** What the chain said about `id` under the watch that started at `since`. */
export interface ChainReading {
  id: string;
  since: number;
  /** true: on Sui; false: gone (two consecutive null reads CHAIN_CONFIRM_MS apart); null: unknown. */
  exists: boolean | null;
  /** Start time of the first null read in the current run of null reads. */
  missingSince: number | null;
}

/**
 * After the reveal: the HTLC verified before it (the bot's id only for old reveals stored without one), counted from the
 * reveal on. Before the reveal: the bot's id, only while the bot reports a claim, which must be confirmed on-chain.
 */
export function chainWatch(reveal: { at: number; htlcObjectId: string | null } | null, view: SwapView | null): ChainWatch | null {
  if (reveal) {
    const id = reveal.htlcObjectId ?? view?.htlcObjectId ?? null;
    return id ? { id, since: reveal.at } : null;
  }
  if ((view?.status === 'SUI_CLAIMED' || view?.status === 'BTC_CLAIMED') && view.htlcObjectId) return { id: view.htlcObjectId, since: 0 };
  return null;
}

/** The watched object's state; a reading of another object or from another watch (e.g. before the reveal) is unknown. */
export function chainExists(reading: ChainReading | null, watch: ChainWatch | null): boolean | null {
  return reading && watch && reading.id === watch.id && reading.since === watch.since ? reading.exists : null;
}

/**
 * Folds one read of `read.id` started at `read.at` (`exists`: object found / not found / read failed = null) into the
 * reading of the current `watch`. Reads of another object or started before the watch began are ignored, so neither a
 * fake id reported by the bot nor a late answer from before the reveal can mark the verified HTLC as claimed.
 */
export function nextChainReading(
  prev: ChainReading | null,
  read: { id: string; exists: boolean | null; at: number },
  watch: ChainWatch | null,
): ChainReading | null {
  if (!watch || read.id !== watch.id || read.at <= watch.since) return prev;
  const base = prev && prev.id === watch.id && prev.since === watch.since ? prev : null;
  // A deleted object does not come back; a later "found" can only be a stale replica.
  if (base?.exists === false) return base;
  const next = { id: watch.id, since: watch.since };
  if (read.exists !== false) return { ...next, exists: read.exists, missingSince: null };
  const missingSince = base?.missingSince ?? read.at;
  return { ...next, exists: read.at - missingSince >= CHAIN_CONFIRM_MS ? false : null, missingSince };
}

/**
 * Where the claim stands, judged from the chain only (the bot's status and the claim request's result do not count).
 * The fallback appears 30 s after the reveal unless the watched object is confirmed gone (a claim deletes it).
 */
export function postRevealState(p: {
  revealedAt: number | null;
  now: number;
  reading: ChainReading | null;
  watch: ChainWatch | null;
}): PostRevealState {
  if (chainExists(p.reading, p.watch) === false) return 'claimed-on-chain';
  if (p.revealedAt !== null && p.now - p.revealedAt >= CLAIM_FALLBACK_MS) return 'show-fallback';
  return 'waiting';
}

/** After the reveal the claim request is repeated until the bot accepts it or the claim is on-chain. */
export function shouldResendClaim(p: {
  revealedAt: number | null;
  claimAccepted: boolean;
  state: PostRevealState;
  now: number;
  lastAttemptAt: number;
}): boolean {
  return p.revealedAt !== null && !p.claimAccepted && p.state !== 'claimed-on-chain' && p.now - p.lastAttemptAt >= CLAIM_RETRY_MS;
}

/**
 * The reveal gate: everything that must hold before the secret leaves the browser. An empty list means reveal; any entry
 * (including an unknown paid amount) means do not.
 */
export function revealProblems(p: {
  htlc: HtlcOnChain;
  /** UTXOs on the HTLC address read from Bitcoin, or null when no Esplora client was given. */
  utxos: Utxo[] | null;
  botDepositSats: number | null;
  recovery: RecoveryFile;
  packageId: string;
  nowMs: number;
}): string[] {
  const paidSats = paidSatsFrom(p.utxos, p.botDepositSats);
  const minAmountMist = paidSats === null ? 0n : minExpectedMist(p.recovery, paidSats);
  // The bot locks SUI for one deposit UTXO only, so after a payment in several parts the lock is short by design.
  const splitDeposit = p.utxos !== null && p.utxos.length > 1 && p.htlc.amountMist < minAmountMist;
  const problems = verifyHtlc(p.htlc, {
    packageId: p.packageId,
    recipient: p.recovery.suiRecipient,
    hash: p.recovery.hash,
    minAmountMist: splitDeposit ? 0n : minAmountMist,
    nowMs: p.nowMs,
    minRemainingMs: MIN_REMAINING_BEFORE_REVEAL_MS,
  });
  if (splitDeposit) problems.push(SPLIT_DEPOSIT_PROBLEM);
  if (paidSats === null) problems.push('deposit amount could not be verified');
  return problems;
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
