import { useState } from 'react';
import { ConnectButton, useCurrentAccount, useSignAndExecuteTransaction } from '@mysten/dapp-kit';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { fromBase64, toBase64 } from '@mysten/sui/utils';
import { suiscanTxUrl } from '@hashbridge/core/links';
import type { RecoveryFile } from '@hashbridge/core/types';
import { buildSelfClaimTx } from '../lib/claim-tx';
import { shortHex } from '../lib/format';
import { Button } from './Button';
import { ExplorerLink } from './ExplorerLink';

export type SuiExecutor = Pick<SuiGrpcClient, 'transactionExecutionService'>;

function decodeGrpcMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  try {
    // grpc-web hands the grpc-message trailer over percent-encoded.
    return decodeURIComponent(message);
  } catch {
    return message;
  }
}

/**
 * Executes the wallet-signed claim over gRPC. dapp-kit's default executor uses JSON-RPC, which public fullnodes no
 * longer serve. The read mask is relative to ExecutedTransaction (the SDK's core.executeTransaction asks for
 * `transaction.*` paths, which the fullnode rejects).
 */
async function executeOverGrpc(client: SuiExecutor, { bytes, signature }: { bytes: string; signature: string }) {
  let response;
  try {
    ({ response } = await client.transactionExecutionService.executeTransaction({
      transaction: { bcs: { value: fromBase64(bytes) } },
      signatures: [{ bcs: { value: fromBase64(signature) }, signature: { oneofKind: undefined } }],
      readMask: { paths: ['digest', 'effects.status', 'effects.bcs'] },
    }));
  } catch (err) {
    throw new Error(decodeGrpcMessage(err));
  }
  const tx = response.transaction;
  const effects = tx?.effects;
  if (!tx?.digest || !effects?.status || !effects.bcs?.value) throw new Error('Sui did not return the claim transaction effects');
  if (!effects.status.success) throw new Error(`Claim failed on Sui: ${effects.status.error?.description ?? 'unknown error'}`);
  // dapp-kit hands these effects to the wallet (reportTransactionEffects).
  return { digest: tx.digest, effects: { bcs: toBase64(effects.bcs.value) } };
}

export function WalletClaim({
  recovery,
  htlcObjectId,
  packageId,
  suiClient,
}: {
  recovery: RecoveryFile;
  htlcObjectId: string | null;
  packageId: string;
  suiClient: SuiExecutor;
}) {
  const account = useCurrentAccount();
  // The wallet resolves gas and object versions itself; only execution goes through our gRPC client.
  const { mutate, isPending } = useSignAndExecuteTransaction({ execute: (signed) => executeOverGrpc(suiClient, signed) });
  const [digest, setDigest] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!account) return <ConnectButton connectText="Connect wallet to claim" />;
  if (digest) {
    return (
      <p>
        Claimed: <ExplorerLink href={suiscanTxUrl(digest)}>{shortHex(digest)}</ExplorerLink>
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <Button
        disabled={isPending || !htlcObjectId || !packageId}
        onClick={() =>
          mutate(
            { transaction: buildSelfClaimTx(packageId, htlcObjectId!, recovery.secret) },
            { onSuccess: (r) => setDigest(r.digest), onError: (e) => setError(e.message) },
          )
        }
      >
        {isPending ? 'Claiming…' : 'Claim myself'}
      </Button>
      {error && <p className="text-red-300">{error}</p>}
    </div>
  );
}
