import type { Utxo } from '@hashbridge/core/types';
import type { EngineDeps, SwapRecord } from '../types';

export function confirmations(u: Utxo, tip: number): number {
  return u.confirmed && u.blockHeight !== null ? tip - u.blockHeight + 1 : 0;
}

/** Earliest confirmed output first, unconfirmed last; ties broken by outpoint so the choice is stable. */
export function pickDeposit(utxos: Utxo[]): Utxo | undefined {
  return [...utxos].sort((a, b) => {
    const ha = a.blockHeight ?? Number.MAX_SAFE_INTEGER;
    const hb = b.blockHeight ?? Number.MAX_SAFE_INTEGER;
    if (ha !== hb) return ha - hb;
    return `${a.txid}:${a.vout}`.localeCompare(`${b.txid}:${b.vout}`);
  })[0];
}

export async function stepAwaitingDeposit(swap: SwapRecord, deps: EngineDeps): Promise<void> {
  const [utxos, tip] = await Promise.all([deps.btc.addressUtxos(swap.htlcAddress), deps.btc.tipHeight()]);

  if (utxos.length > 0 && swap.depositFirstSeenAt === null) {
    swap = deps.repo.update(swap.swapId, { depositFirstSeenAt: deps.now() });
  }

  const deposit = pickDeposit(utxos.filter((u) => confirmations(u, tip) >= deps.config.minConf));
  if (!deposit) {
    if (tip >= swap.locktime) {
      deps.repo.update(swap.swapId, { status: 'EXPIRED' });
      deps.log('swap expired without a deposit', { swapId: swap.swapId });
    }
    return;
  }

  deps.repo.update(swap.swapId, {
    status: 'DEPOSIT_SEEN',
    depositTxid: deposit.txid,
    depositVout: deposit.vout,
    depositSats: deposit.value,
  });
  deps.log('deposit seen', { swapId: swap.swapId, txid: deposit.txid, sats: deposit.value });
}
