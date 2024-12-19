import { SuiClient, type SuiTransactionBlockResponse } from '@mysten/sui/client';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction, TransactionDataBuilder } from '@mysten/sui/transactions';
// Deviation from the brief: hex helpers come from @mysten/sui/utils because @hashbridge/core/secret (Task 3) is not merged yet.
import { fromBase64, fromHex as hexToBytes, normalizeSuiAddress, toBase64, toHex as bytesToHex } from '@mysten/sui/utils';
import type { ClaimEventInfo, LockParams, SignedTx, SuiChain, SuiTxKind, SuiTxResult } from './types';

export interface SuiChainOptions {
  rpcUrl: string;
  privateKey: string;
  packageId: string;
}

const SUI_TYPE = '0x2::sui::SUI';

export function bytesFromMoveJson(value: unknown): Uint8Array {
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  if (typeof value === 'string') return fromBase64(value);
  throw new Error('unexpected vector<u8> encoding in Move JSON');
}

export function toTxResult(res: SuiTransactionBlockResponse, packageId: string): SuiTxResult {
  const status = res.effects?.status;
  const locked = res.events?.find((e) => e.type === `${normalizeSuiAddress(packageId)}::htlc::Locked`);
  const htlcId = (locked?.parsedJson as { htlc_id?: string } | undefined)?.htlc_id ?? null;
  return {
    digest: res.digest,
    success: status?.status === 'success',
    error: status?.error ?? null,
    htlcObjectId: htlcId,
  };
}

export function findClaimInEvents(
  events: ReadonlyArray<{ id: { txDigest: string }; parsedJson: unknown }>,
  htlcObjectId: string,
): ClaimEventInfo | null {
  for (const event of events) {
    const parsed = event.parsedJson as { htlc_id?: string; preimage?: unknown };
    // Only Claimed events carry a preimage; Locked/Refunded events of the same HTLC are skipped.
    if (parsed?.htlc_id === htlcObjectId && parsed.preimage !== undefined) {
      return { digest: event.id.txDigest, preimage: bytesToHex(bytesFromMoveJson(parsed.preimage)) };
    }
  }
  return null;
}

/** True only for the RPC's "transaction not found" error; timeouts, rate limits and the like are not. */
export function isTxNotFoundError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : '';
  return /could not find|not found|does not exist/i.test(message);
}

export function createSuiChain(opts: SuiChainOptions): SuiChain {
  const client = new SuiClient({ url: opts.rpcUrl });
  const { secretKey } = decodeSuiPrivateKey(opts.privateKey);
  const keypair = Ed25519Keypair.fromSecretKey(secretKey);
  const address = keypair.toSuiAddress();
  const pkg = normalizeSuiAddress(opts.packageId);
  const target = (fn: string) => `${pkg}::htlc::${fn}`;
  const options = { showEffects: true, showEvents: true } as const;

  async function sign(kind: SuiTxKind, tx: Transaction): Promise<SignedTx> {
    tx.setSender(address);
    const bytes = await tx.build({ client });
    const { signature } = await keypair.signTransaction(bytes);
    return { kind, digest: TransactionDataBuilder.getDigestFromBytes(bytes), bytes: toBase64(bytes), signature };
  }

  return {
    address: () => address,

    async balanceMist() {
      const balance = await client.getBalance({ owner: address });
      return BigInt(balance.totalBalance);
    },

    signLock(p: LockParams) {
      const tx = new Transaction();
      const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(p.amountMist)]);
      tx.moveCall({
        target: target('lock'),
        typeArguments: [SUI_TYPE],
        arguments: [coin!, tx.pure.address(p.recipient), tx.pure.vector('u8', Array.from(hexToBytes(p.hash))), tx.pure.u64(p.deadlineMs), tx.object.clock()],
      });
      return sign('lock', tx);
    },

    signClaim(htlcObjectId: string, preimage: string) {
      const tx = new Transaction();
      tx.moveCall({
        target: target('claim'),
        typeArguments: [SUI_TYPE],
        arguments: [tx.object(htlcObjectId), tx.pure.vector('u8', Array.from(hexToBytes(preimage))), tx.object.clock()],
      });
      return sign('claim', tx);
    },

    signRefund(htlcObjectId: string) {
      const tx = new Transaction();
      tx.moveCall({ target: target('refund'), typeArguments: [SUI_TYPE], arguments: [tx.object(htlcObjectId), tx.object.clock()] });
      return sign('refund', tx);
    },

    async execute(tx: SignedTx) {
      const res = await client.executeTransactionBlock({ transactionBlock: tx.bytes, signature: tx.signature, options });
      await client.waitForTransaction({ digest: res.digest });
      return toTxResult(res, pkg);
    },

    async lookup(digest: string) {
      try {
        return toTxResult(await client.getTransactionBlock({ digest, options }), pkg);
      } catch (err) {
        if (isTxNotFoundError(err)) return null;
        throw err;
      }
    },

    async findClaim(htlcObjectId: string) {
      // Claim consumes the shared Htlc, so at most two transactions ever touch it (lock, then claim or refund): one page is enough.
      const page = await client.queryTransactionBlocks({
        filter: { InputObject: htlcObjectId },
        options: { showEvents: true },
        order: 'descending',
        limit: 50,
      });
      const claimed = page.data.flatMap((txb) => txb.events ?? []).filter((e) => e.type === target('Claimed'));
      return findClaimInEvents(claimed, htlcObjectId);
    },
  };
}
