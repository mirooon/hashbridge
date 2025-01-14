import { buildClaimTx } from '@hashbridge/core/btc-tx';
import { p2wpkhAddress } from '@hashbridge/core/keys';
import { hexToBytes, secretMatchesHash } from '@hashbridge/core/secret';
import type { EngineDeps, SwapRecord } from '../types';
import { submitOnce } from './pending';

const ALREADY_BROADCAST = /txn-already-(in-mempool|known)|already in block chain|already in utxo set|already known/i;

export async function stepDetectClaim(swap: SwapRecord, deps: EngineDeps): Promise<boolean> {
  if (swap.pendingTx?.kind === 'claim') {
    // A relayed claim from the API was interrupted; the preimage is already stored.
    const result = await submitOnce(swap, deps, 'claim', () => Promise.reject(new Error('claim txs are signed by the API')));
    if (!result.success) return false;
    deps.repo.update(swap.swapId, { status: 'SUI_CLAIMED', claimDigest: result.digest });
    return true;
  }

  const claim = await deps.sui.findClaim(swap.htlcObjectId!);
  if (!claim) return false;
  deps.repo.update(swap.swapId, { status: 'SUI_CLAIMED', preimage: claim.preimage, claimDigest: claim.digest });
  deps.log('claim detected on Sui', { swapId: swap.swapId, digest: claim.digest });
  return true;
}

export async function stepSuiClaimed(swap: SwapRecord, deps: EngineDeps): Promise<void> {
  let hex = swap.btcClaimTxHex;
  if (!hex) {
    if (!swap.preimage || !secretMatchesHash(swap.preimage, swap.hash)) {
      throw new Error(`swap ${swap.swapId}: stored preimage does not match the hash`);
    }
    const built = buildClaimTx({
      utxo: { txid: swap.depositTxid!, vout: swap.depositVout!, value: swap.depositSats! },
      witnessScript: hexToBytes(swap.witnessScript),
      preimage: hexToBytes(swap.preimage),
      claimKey: deps.botKey,
      destination: p2wpkhAddress(deps.botKey.publicKey),
      feeRate: await deps.btc.feeRate(),
    });
    hex = built.hex;
    // Stored before broadcasting so a retry sends the identical tx.
    deps.repo.update(swap.swapId, { btcClaimTxHex: built.hex, btcClaimTxid: built.txid });
  }

  try {
    await deps.btc.broadcast(hex);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!ALREADY_BROADCAST.test(message)) throw err;
    deps.log('BTC claim tx was already broadcast', { swapId: swap.swapId });
  }
  deps.repo.update(swap.swapId, { status: 'BTC_CLAIMED' });
  deps.log('BTC claimed', { swapId: swap.swapId });
}
