import { buildRefundTx } from '@hashbridge/core/btc-tx';
import { htlcAddress } from '@hashbridge/core/htlc-script';
import { btcKeyFromPrivateKeyHex } from '@hashbridge/core/keys';
import { hexToBytes, secretMatchesHash } from '@hashbridge/core/secret';
import type { BtcChain, RecoveryFile, SwapView } from '@hashbridge/core/types';
import { parseRecoveryFile, type LocalSwapState, type SwapStorage } from './storage';

export const REFUND_OFFER_AFTER_MS = 10 * 60_000;

export function refundOffered(view: SwapView | null, createdAt: number, now: number): boolean {
  if (view && (view.status === 'REJECTED' || view.status === 'EXPIRED' || view.status === 'SUI_REFUNDED')) return true;
  const stalled = now - createdAt > REFUND_OFFER_AFTER_MS;
  if (!view) return stalled;
  return stalled && (view.status === 'AWAITING_DEPOSIT' || view.status === 'DEPOSIT_SEEN');
}

/** A tx with nLockTime L is accepted once the chain tip reaches L (it can be mined in block L + 1). */
export function blocksUntilRefund(locktime: number, tip: number): number {
  return Math.max(0, locktime - tip);
}

export async function executeRefund(recovery: RecoveryFile, destination: string, btc: BtcChain): Promise<{ txid: string }> {
  const tip = await btc.tipHeight();
  const remaining = blocksUntilRefund(recovery.locktime, tip);
  if (remaining > 0) throw new Error(`Refund available in ${remaining} block${remaining === 1 ? '' : 's'}`);
  const utxos = await btc.addressUtxos(recovery.htlcAddress);
  if (utxos.length === 0) throw new Error('Nothing to refund: the HTLC address holds no funds');
  const built = buildRefundTx({
    utxos,
    witnessScript: hexToBytes(recovery.witnessScript),
    locktime: recovery.locktime,
    refundKey: btcKeyFromPrivateKeyHex(recovery.refundPrivkey),
    destination,
    feeRate: await btc.feeRate(),
  });
  return { txid: await btc.broadcast(built.hex) };
}

export function importRecoveryFile(text: string, storage: SwapStorage): LocalSwapState {
  const recovery = parseRecoveryFile(text);
  if (!secretMatchesHash(recovery.secret, recovery.hash)) throw new Error('Invalid recovery file: secret does not match the hash');
  if (htlcAddress(hexToBytes(recovery.witnessScript)) !== recovery.htlcAddress) {
    throw new Error('Invalid recovery file: HTLC address does not match the script');
  }
  const state: LocalSwapState = { recovery, recoveryDownloaded: true, claimSentAt: null };
  storage.save(state);
  return state;
}
