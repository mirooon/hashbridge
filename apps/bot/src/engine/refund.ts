import type { EngineDeps, SwapRecord } from '../types';
import { submitOnce } from './pending';

export async function stepRefundSui(swap: SwapRecord, deps: EngineDeps): Promise<void> {
  const resuming = swap.pendingTx?.kind === 'refund';
  if (!resuming && deps.now() < swap.suiDeadlineMs!) return;

  const result = await submitOnce(swap, deps, 'refund', () => deps.sui.signRefund(swap.htlcObjectId!));
  if (!result.success) throw new Error(`refund tx ${result.digest} failed: ${result.error}`);
  deps.repo.update(swap.swapId, { status: 'SUI_REFUNDED', refundDigest: result.digest });
  deps.log('SUI refunded', { swapId: swap.swapId, digest: result.digest });
}
