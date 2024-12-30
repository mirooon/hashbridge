import type { SuiObjectResponse } from '@mysten/sui/client';
import { describe, expect, it } from 'vitest';
import { fetchHtlc, parseHtlcObject, verifyHtlc } from '../src/lib/sui-verify';

const PKG = '0x' + '1'.repeat(64);
const HASH = '4bb06f8e4e3a7715d201d573d0aa423762e55dabd61a2c02278fa56cc6d294e0';
const USER = '0x' + 'a'.repeat(64);
const NOW = 1_700_000_000_000;

function response(fields: Record<string, unknown> = {}, type = `${PKG}::htlc::Htlc<0x2::sui::SUI>`): SuiObjectResponse {
  return {
    data: {
      objectId: '0xabc', version: '1', digest: 'd', type,
      content: {
        dataType: 'moveObject', type, hasPublicTransfer: false,
        fields: {
          id: { id: '0xabc' }, balance: '12338000000', sender: '0x' + 'b'.repeat(64), recipient: USER,
          hash: Array.from(Buffer.from(HASH, 'hex')), refund_after_ms: String(NOW + 3_600_000), ...fields,
        },
      },
    },
  } as unknown as SuiObjectResponse;
}

const expected = { packageId: PKG, recipient: USER, hash: HASH, minAmountMist: 12_338_000_000n, nowMs: NOW, minRemainingMs: 600_000 };

describe('parseHtlcObject', () => {
  it('reads the Htlc fields', () => {
    expect(parseHtlcObject(response())).toEqual({
      id: '0xabc', type: `${PKG}::htlc::Htlc<0x2::sui::SUI>`, amountMist: 12_338_000_000n,
      sender: '0x' + 'b'.repeat(64), recipient: USER, hash: HASH, refundAfterMs: NOW + 3_600_000,
    });
  });

  it('accepts Balance rendered as a struct', () => {
    expect(parseHtlcObject(response({ balance: { type: 'x', fields: { value: '5' } } }))?.amountMist).toBe(5n);
  });

  it('returns null for missing or foreign content', () => {
    expect(parseHtlcObject({ data: null } as unknown as SuiObjectResponse)).toBeNull();
    expect(parseHtlcObject(response({ recipient: undefined }))).toBeNull();
  });
});

describe('verifyHtlc', () => {
  const ok = parseHtlcObject(response())!;

  it('accepts a matching HTLC', () => {
    expect(verifyHtlc(ok, expected)).toEqual([]);
  });

  it('flags an object from another package', () => {
    const fake = parseHtlcObject(response({}, `0x${'9'.repeat(64)}::htlc::Htlc<0x2::sui::SUI>`))!;
    expect(verifyHtlc(fake, expected).join()).toMatch(/unexpected object type/);
  });

  it('flags the wrong recipient, hash, amount and deadline', () => {
    expect(verifyHtlc({ ...ok, recipient: '0x' + 'c'.repeat(64) }, expected).join()).toMatch(/different address/);
    expect(verifyHtlc({ ...ok, hash: '00'.repeat(32) }, expected).join()).toMatch(/hash/);
    expect(verifyHtlc({ ...ok, amountMist: 1n }, expected).join()).toMatch(/below/);
    expect(verifyHtlc({ ...ok, refundAfterMs: NOW + 60_000 }, expected).join()).toMatch(/minutes/);
  });

  it('refuses to verify without a configured package id', () => {
    expect(verifyHtlc(ok, { ...expected, packageId: '' }).join()).toMatch(/VITE_HTLC_PACKAGE_ID/);
  });
});

describe('fetchHtlc', () => {
  it('asks for content and parses the response', async () => {
    let seen: unknown;
    const client = { getObject: async (input: unknown) => { seen = input; return response(); } };
    expect((await fetchHtlc(client as never, '0xabc'))?.id).toBe('0xabc');
    expect(seen).toEqual({ id: '0xabc', options: { showContent: true, showType: true } });
  });
});
