import { isTerminal } from '@hashbridge/core/types';
import type { EngineDeps, SwapRecord } from '../types';
import { stepDetectClaim, stepSuiClaimed } from './claim';
import { stepAwaitingDeposit } from './deposit';
import { stepDepositSeen } from './lock';
import { stepRefundSui } from './refund';

const MAX_STEPS_PER_TICK = 5;

async function step(swap: SwapRecord, deps: EngineDeps): Promise<void> {
  switch (swap.status) {
    case 'AWAITING_DEPOSIT':
      return stepAwaitingDeposit(swap, deps);
    case 'DEPOSIT_SEEN':
      return stepDepositSeen(swap, deps);
    case 'SUI_LOCKED': {
      if (await stepDetectClaim(swap, deps)) return;
      return stepRefundSui(deps.repo.get(swap.swapId) ?? swap, deps);
    }
    case 'SUI_CLAIMED':
      return stepSuiClaimed(swap, deps);
    default:
      return;
  }
}

/** Advances one swap as far as it can go now, so a demo swap does not wait a poll interval per state. */
export async function processSwap(swap: SwapRecord, deps: EngineDeps): Promise<void> {
  let current: SwapRecord | undefined = swap;
  for (let i = 0; i < MAX_STEPS_PER_TICK && current && !isTerminal(current.status); i++) {
    const before = current.status;
    await step(current, deps);
    current = deps.repo.get(swap.swapId);
    if (!current || current.status === before) return;
  }
}

export async function tick(deps: EngineDeps): Promise<void> {
  for (const swap of deps.repo.listActive()) {
    try {
      await processSwap(swap, deps);
    } catch (err) {
      deps.log('swap step failed', {
        swapId: swap.swapId,
        status: swap.status,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export async function startLoop(deps: EngineDeps, signal?: AbortSignal): Promise<void> {
  while (!signal?.aborted) {
    try {
      await tick(deps);
    } catch (err) {
      // e.g. the database failing in listActive: log it and try again next cycle instead of crashing the process.
      deps.log('tick failed', { error: err instanceof Error ? err.message : String(err) });
    }
    await new Promise((resolve) => setTimeout(resolve, deps.config.pollIntervalMs));
  }
}
