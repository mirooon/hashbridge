import { fromBase64, normalizeStructTag, normalizeSuiAddress, toHex as bytesToHex } from '@mysten/sui/utils';
import type { FetchLike } from './api';

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

export interface HtlcReader {
  /** Resolves to null when the object does not exist (or was deleted) or is not shaped like an Htlc. */
  fetchHtlc(id: string): Promise<HtlcOnChain | null>;
}

/** Field names follow the schema served at graphql.<network>.sui.io (checked by introspection). */
export const HTLC_QUERY = `query HashbridgeHtlc($id: SuiAddress!) {
  object(address: $id) {
    address
    asMoveObject { contents { type { repr } json } }
  }
}`;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const DIGITS = /^\d+$/;

/** In the `json` rendering, vector<u8> is a Base64 string. */
function base64ToHex(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  try {
    return bytesToHex(fromBase64(v));
  } catch {
    return null;
  }
}

/**
 * Parses the `object` node of HTLC_QUERY's response. In the `json` rendering u64 and Balance are decimal strings and
 * addresses are canonical hex strings. Missing (never existed or deleted) and malformed objects give null.
 */
export function parseHtlcObject(node: unknown): HtlcOnChain | null {
  if (!isRecord(node) || typeof node.address !== 'string') return null;
  const contents = isRecord(node.asMoveObject) ? node.asMoveObject.contents : null;
  if (!isRecord(contents) || !isRecord(contents.type) || typeof contents.type.repr !== 'string' || !isRecord(contents.json)) return null;
  const f = contents.json;
  const hash = base64ToHex(f.hash);
  if (typeof f.balance !== 'string' || !DIGITS.test(f.balance) || hash === null) return null;
  if (typeof f.sender !== 'string' || typeof f.recipient !== 'string') return null;
  if (typeof f.refund_after_ms !== 'string' || !DIGITS.test(f.refund_after_ms)) return null;
  return {
    id: node.address,
    type: contents.type.repr,
    amountMist: BigInt(f.balance),
    sender: f.sender,
    recipient: f.recipient,
    hash,
    refundAfterMs: Number(f.refund_after_ms),
  };
}

/**
 * Reads an Htlc through Sui GraphQL (public fullnodes no longer serve JSON-RPC). Transport and GraphQL errors throw, so
 * the caller can tell "could not read" from "not there".
 */
export function createGraphqlHtlcReader(url: string, fetchFn: FetchLike = (input, init) => fetch(input, init)): HtlcReader {
  return {
    async fetchHtlc(id) {
      const res = await fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: HTLC_QUERY, variables: { id } }),
      });
      if (!res.ok) throw new Error(`Sui GraphQL answered HTTP ${res.status}`);
      const body = (await res.json()) as { data?: { object?: unknown } | null; errors?: { message?: string }[] } | null;
      if (body?.errors?.length) throw new Error(`Sui GraphQL error: ${body.errors.map((e) => e.message).join('; ')}`);
      return parseHtlcObject(body?.data?.object);
    },
  };
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
