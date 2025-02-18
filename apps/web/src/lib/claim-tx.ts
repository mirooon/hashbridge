import { Transaction } from '@mysten/sui/transactions';
import { hexToBytes } from '@hashbridge/core/secret';

export function buildSelfClaimTx(packageId: string, htlcObjectId: string, secretHex: string): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::htlc::claim`,
    typeArguments: ['0x2::sui::SUI'],
    arguments: [tx.object(htlcObjectId), tx.pure.vector('u8', Array.from(hexToBytes(secretHex))), tx.object.clock()],
  });
  return tx;
}
