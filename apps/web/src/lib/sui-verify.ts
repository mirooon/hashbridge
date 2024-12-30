import type { SuiClient, SuiObjectResponse } from '@mysten/sui/client';
import { fromBase64, normalizeStructTag, normalizeSuiAddress, toHex as bytesToHex } from '@mysten/sui/utils';

export interface HtlcOnChain {
  id: string;
  type: string;
  amountMist: bigint;
  sender: string;
  recipient: string;
  hash: string;
  refundAfterMs: number;
}

export interface ExpectedHtlc {
  packageId: string;
  recipient: string;
  hash: string;
  minAmountMist: bigint;
  nowMs: number;
  minRemainingMs: number;
}

export function parseHtlcObject(resp: SuiObjectResponse): HtlcOnChain | null {
  const content = resp.data?.content;
  if (!resp.data || !content || content.dataType !== 'moveObject') return null;
  const f = content.fields as Record<string, unknown>;
  const balance =
    typeof f.balance === 'string' ? f.balance : (f.balance as { fields?: { value?: string } } | undefined)?.fields?.value;
  const hash = Array.isArray(f.hash)
    ? bytesToHex(Uint8Array.from(f.hash as number[]))
    : typeof f.hash === 'string'
      ? bytesToHex(fromBase64(f.hash))
      : null;
  if (typeof balance !== 'string' || hash === null) return null;
  if (typeof f.sender !== 'string' || typeof f.recipient !== 'string' || typeof f.refund_after_ms !== 'string') return null;
  return {
    id: resp.data.objectId,
    type: content.type,
    amountMist: BigInt(balance),
    sender: f.sender,
    recipient: f.recipient,
    hash,
    refundAfterMs: Number(f.refund_after_ms),
  };
}

export async function fetchHtlc(client: Pick<SuiClient, 'getObject'>, id: string): Promise<HtlcOnChain | null> {
  const resp = await client.getObject({ id, options: { showContent: true, showType: true } });
  return parseHtlcObject(resp);
}

export function verifyHtlc(h: HtlcOnChain, e: ExpectedHtlc): string[] {
  if (!e.packageId) return ['VITE_HTLC_PACKAGE_ID is not configured, cannot verify the HTLC'];
  const problems: string[] = [];
  const expectedType = normalizeStructTag(`${normalizeSuiAddress(e.packageId)}::htlc::Htlc<0x2::sui::SUI>`);
  if (normalizeStructTag(h.type) !== expectedType) problems.push(`unexpected object type ${h.type}`);
  if (normalizeSuiAddress(h.recipient) !== normalizeSuiAddress(e.recipient)) problems.push('SUI would go to a different address');
  if (h.hash !== e.hash) problems.push('HTLC hash does not match your secret');
  if (h.amountMist < e.minAmountMist) problems.push(`locked amount ${h.amountMist} MIST is below the expected ${e.minAmountMist} MIST`);
  if (h.refundAfterMs - e.nowMs < e.minRemainingMs) {
    problems.push(`less than ${Math.round(e.minRemainingMs / 60_000)} minutes left before the Sui deadline`);
  }
  return problems;
}
