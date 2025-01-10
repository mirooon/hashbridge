import { quoteMist } from '@hashbridge/core/pricing';
import type { BotConfig, EngineDeps, SwapRecord } from '../types';
import { submitOnce } from './pending';

export function rejectionReason(swap: SwapRecord, tip: number, balanceMist: bigint, amountMist: bigint, config: BotConfig): string | null {
  if (swap.depositFirstSeenAt !== null && swap.depositFirstSeenAt > swap.quoteExpiresAt) return 'quote expired before the deposit arrived';
  if ((swap.depositSats ?? 0) < config.minBtcSats) return 'deposit below minimum';
  if (tip + config.safetyBlocks >= swap.locktime) return 'too close to the BTC locktime';
  if (balanceMist < amountMist + config.gasReserveMist) return 'insufficient SUI liquidity';
  return null;
}

export async function stepDepositSeen(swap: SwapRecord, deps: EngineDeps): Promise<void> {
  if (swap.pendingTx?.kind === 'lock') return finishLock(swap, deps);

  const { config } = deps;
  const sats = Math.min(swap.depositSats ?? 0, config.maxBtcSats);
  const amount = quoteMist(sats, config.rate, config.spreadBps);
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
  if (!result.success || !result.htlcObjectId) {
    throw new Error(`lock tx ${result.digest} failed: ${result.error ?? 'no Locked event'}`);
  }
  deps.repo.update(swap.swapId, { status: 'SUI_LOCKED', htlcObjectId: result.htlcObjectId, lockDigest: result.digest });
  deps.log('SUI locked', { swapId: swap.swapId, digest: result.digest, htlcObjectId: result.htlcObjectId });
}
