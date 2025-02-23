import type { BotConfig, EngineDeps, SwapRecord } from '../types';
import { submitOnce } from './pending';

const NO_LOCKED_EVENT = 'lock landed without Locked event; manual action needed';

export function rejectionReason(swap: SwapRecord, tip: number, balanceMist: bigint, amountMist: bigint, config: BotConfig): string | null {
  if (swap.depositFirstSeenAt !== null && swap.depositFirstSeenAt > swap.quoteExpiresAt) return 'quote expired before the deposit arrived';
  if ((swap.depositSats ?? 0) < config.minBtcSats) return 'deposit below minimum';
  if (tip + config.safetyBlocks >= swap.locktime) return 'too close to the BTC locktime';
  if (balanceMist < amountMist + config.gasReserveMist) return 'insufficient SUI liquidity';
  return null;
}

/**
 * SUI to lock: the quote given at POST /swaps scaled to the deposit actually seen (up to MAX_BTC_SATS), so the user gets
 * the quoted rate even if RATE changed since. Once a lock was priced (suiDeadlineMs set), `suiAmount` already holds the
 * lock amount and is reused as is, so retrying a failed lock never scales it twice.
 */
export function lockAmountMist(swap: SwapRecord, config: BotConfig): bigint {
  if (swap.suiDeadlineMs !== null) return BigInt(swap.suiAmount);
  const sats = Math.min(swap.depositSats ?? 0, config.maxBtcSats);
  return (BigInt(swap.suiAmount) * BigInt(sats)) / BigInt(swap.btcSats);
}

export async function stepDepositSeen(swap: SwapRecord, deps: EngineDeps): Promise<void> {
  // A lock already landed on Sui but its Htlc could not be identified: signing another one would lock the SUI twice.
  if (swap.lockDigest) {
    deps.log(NO_LOCKED_EVENT, { swapId: swap.swapId, lockDigest: swap.lockDigest });
    return;
  }
  if (swap.pendingTx?.kind === 'lock') return finishLock(swap, deps);

  const { config } = deps;
  const amount = lockAmountMist(swap, config);
  const [tip, balance] = await Promise.all([deps.btc.tipHeight(), deps.sui.balanceMist()]);

  const reason = rejectionReason(swap, tip, balance, amount, config);
  if (reason) {
    deps.repo.update(swap.swapId, { status: 'REJECTED', rejectReason: reason });
    deps.log('swap rejected', { swapId: swap.swapId, reason });
    return;
  }

  // Amount and deadline are stored before signing, so a resumed lock uses the same values.
  const prepared = deps.repo.update(swap.swapId, {
    suiAmount: amount.toString(),
    suiDeadlineMs: deps.now() + config.suiTimeoutMs,
  });
  await finishLock(prepared, deps);
}

async function finishLock(swap: SwapRecord, deps: EngineDeps): Promise<void> {
  const result = await submitOnce(swap, deps, 'lock', () =>
    deps.sui.signLock({
      recipient: swap.suiRecipient,
      hash: swap.hash,
      amountMist: BigInt(swap.suiAmount),
      deadlineMs: swap.suiDeadlineMs!,
    }),
  );
  if (!result.success) throw new Error(`lock tx ${result.digest} failed: ${result.error ?? 'unknown error'}`);
  if (!result.htlcObjectId) {
    // The SUI is locked, but without the Locked event (e.g. the package was upgraded, so the event type has another
    // package id) the bot cannot tell which Htlc holds it. Remember the digest so no tick signs a second lock.
    deps.repo.update(swap.swapId, { lockDigest: result.digest });
    deps.log(NO_LOCKED_EVENT, { swapId: swap.swapId, lockDigest: result.digest });
    throw new Error(`lock tx ${result.digest} succeeded but has no Locked event of package ${deps.config.htlcPackageId}; manual action needed`);
  }
  deps.repo.update(swap.swapId, { status: 'SUI_LOCKED', htlcObjectId: result.htlcObjectId, lockDigest: result.digest });
  deps.log('SUI locked', { swapId: swap.swapId, digest: result.digest, htlcObjectId: result.htlcObjectId });
}
