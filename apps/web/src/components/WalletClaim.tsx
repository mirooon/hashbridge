import { useState } from 'react';
import { ConnectButton, useCurrentAccount, useSignAndExecuteTransaction } from '@mysten/dapp-kit';
import { suiscanTxUrl } from '@hashbridge/core/links';
import type { RecoveryFile } from '@hashbridge/core/types';
import { buildSelfClaimTx } from '../lib/claim-tx';
import { shortHex } from '../lib/format';
import { Button } from './Button';
import { ExplorerLink } from './ExplorerLink';

export function WalletClaim({ recovery, htlcObjectId, packageId }: { recovery: RecoveryFile; htlcObjectId: string | null; packageId: string }) {
  const account = useCurrentAccount();
  const { mutate, isPending } = useSignAndExecuteTransaction();
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
