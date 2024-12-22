import type { EngineDeps, SignedTx, SuiTxKind, SuiTxResult, SwapRecord } from '../types';

let queue: Promise<unknown> = Promise.resolve();

/** Runs Sui submissions one at a time, so two txs never race for the same gas coin. */
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

const STALE_INPUTS = /unavailable for consumption|needs to be rebuilt|ObjectVersionUnavailable/i;

/**
 * Executes a Sui tx for `swap` at most once across restarts:
 * the signed tx is stored before it is sent, and a stored tx is looked up before it is re-sent.
 */
export function submitOnce(
  swap: SwapRecord,
  deps: EngineDeps,
  kind: SuiTxKind,
  sign: () => Promise<SignedTx>,
): Promise<SuiTxResult> {
  return serialize(async () => {
    const current = deps.repo.get(swap.swapId) ?? swap;
    const pending = current.pendingTx;
    if (pending && pending.kind !== kind) {
      throw new Error(`swap ${swap.swapId} has a pending ${pending.kind} tx; cannot start ${kind}`);
    }

    let signed: SignedTx;
    if (pending) {
      const landed = await deps.sui.lookup(pending.digest);
      if (landed) {
        deps.repo.update(swap.swapId, { pendingTx: null });
        return landed;
      }
      signed = pending;
    } else {
      signed = await sign();
      deps.repo.update(swap.swapId, { pendingTx: signed });
    }

    try {
      const result = await deps.sui.execute(signed);
      deps.repo.update(swap.swapId, { pendingTx: null });
      return result;
    } catch (err) {
      let landed: SuiTxResult | null;
      try {
        landed = await deps.sui.lookup(signed.digest);
      } catch {
        // Unknown whether the tx landed: keep pendingTx so a restart looks it up again.
        throw err;
      }
      if (landed) {
        deps.repo.update(swap.swapId, { pendingTx: null });
        return landed;
      }
      if (STALE_INPUTS.test(err instanceof Error ? err.message : String(err))) {
        deps.repo.update(swap.swapId, { pendingTx: null });
      }
      throw err;
    }
  });
}
