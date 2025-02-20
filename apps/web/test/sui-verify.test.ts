import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../src/lib/api';
import { createGraphqlHtlcReader, parseHtlcObject, verifyHtlc } from '../src/lib/sui-verify';

const PKG = '0x' + '1'.repeat(64);
const HASH = '4bb06f8e4e3a7715d201d573d0aa423762e55dabd61a2c02278fa56cc6d294e0';
const USER = '0x' + 'a'.repeat(64);
const SENDER = '0x' + 'b'.repeat(64);
const ID = '0x' + 'd'.repeat(64);
const NOW = 1_700_000_000_000;
const URL = 'https://graphql.example/graphql';

/** The `object` node of the GraphQL response, as graphql.testnet.sui.io renders an Htlc. */
function node(json: Record<string, unknown> = {}, type = `${PKG}::htlc::Htlc<0x2::sui::SUI>`) {
  return {
    address: ID,
    asMoveObject: {
      contents: {
        type: { repr: type },
        json: {
          id: ID, balance: '12338000000', sender: SENDER, recipient: USER,
          hash: Buffer.from(HASH, 'hex').toString('base64'), refund_after_ms: String(NOW + 3_600_000), ...json,
        },
      },
    },
  };
}

const expected = { packageId: PKG, recipient: USER, hash: HASH, minAmountMist: 12_338_000_000n, nowMs: NOW, minRemainingMs: 600_000 };

describe('parseHtlcObject', () => {
  it('reads the Htlc fields', () => {
    expect(parseHtlcObject(node())).toEqual({
      id: ID, type: `${PKG}::htlc::Htlc<0x2::sui::SUI>`, amountMist: 12_338_000_000n,
      sender: SENDER, recipient: USER, hash: HASH, refundAfterMs: NOW + 3_600_000,
    });
  });

  it('returns null for a missing or deleted object', () => {
    expect(parseHtlcObject(null)).toBeNull();
    expect(parseHtlcObject(undefined)).toBeNull();
  });

  it('returns null for an object that is not a Move object', () => {
    expect(parseHtlcObject({ address: ID, asMoveObject: null })).toBeNull();
    expect(parseHtlcObject({ address: ID, asMoveObject: { contents: null } })).toBeNull();
  });

  it('returns null for contents of the wrong shape', () => {
    expect(parseHtlcObject(node({ recipient: undefined }))).toBeNull();
    expect(parseHtlcObject(node({ sender: 7 }))).toBeNull();
    expect(parseHtlcObject(node({ balance: 12338000000 }))).toBeNull();
    expect(parseHtlcObject(node({ balance: '12.5' }))).toBeNull();
    expect(parseHtlcObject(node({ refund_after_ms: 'soon' }))).toBeNull();
    expect(parseHtlcObject(node({ hash: [1, 2, 3] }))).toBeNull();
    expect(parseHtlcObject(node({ hash: '!not base64!' }))).toBeNull();
    expect(parseHtlcObject({ ...node(), address: 42 })).toBeNull();
    expect(parseHtlcObject({ address: ID, asMoveObject: { contents: { type: null, json: node().asMoveObject.contents.json } } })).toBeNull();
    expect(parseHtlcObject({ address: ID, asMoveObject: { contents: { type: { repr: 'x' }, json: 'nope' } } })).toBeNull();
    expect(parseHtlcObject('nope')).toBeNull();
  });

  it('returns null for an unrelated object but leaves the package check of an Htlc to verifyHtlc', () => {
    const clock = { address: '0x' + '0'.repeat(63) + '6', asMoveObject: { contents: { type: { repr: '0x2::clock::Clock' }, json: { id: '0x6', timestamp_ms: '1' } } } };
    expect(parseHtlcObject(clock)).toBeNull();
    expect(parseHtlcObject(node({}, `0x${'9'.repeat(64)}::htlc::Htlc<0x2::sui::SUI>`))?.type).toBe(`0x${'9'.repeat(64)}::htlc::Htlc<0x2::sui::SUI>`);
  });
});

describe('verifyHtlc', () => {
  const ok = parseHtlcObject(node())!;

  it('accepts a matching HTLC', () => {
    expect(verifyHtlc(ok, expected)).toEqual([]);
  });

  it('flags an object from another package', () => {
    const fake = parseHtlcObject(node({}, `0x${'9'.repeat(64)}::htlc::Htlc<0x2::sui::SUI>`))!;
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

describe('createGraphqlHtlcReader', () => {
  function fakeFetch(body: unknown, status = 200) {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchFn: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
    };
    return { calls, fetchFn };
  }

  it('posts the object query with the id variable and parses the response', async () => {
    const { calls, fetchFn } = fakeFetch({ data: { object: node() } });
    expect((await createGraphqlHtlcReader(URL, fetchFn).fetchHtlc(ID))?.amountMist).toBe(12_338_000_000n);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(URL);
    expect(calls[0].init?.method).toBe('POST');
    expect(new Headers(calls[0].init?.headers).get('content-type')).toBe('application/json');
    const sent = JSON.parse(String(calls[0].init?.body)) as { query: string; variables: unknown };
    expect(sent.variables).toEqual({ id: ID });
    expect(sent.query).toMatch(/\$id: SuiAddress!/);
    expect(sent.query).toMatch(/object\(address: \$id\)/);
    expect(sent.query).toMatch(/contents \{ type \{ repr \} json \}/);
  });

  it('returns null when the object does not exist or was deleted', async () => {
    const { fetchFn } = fakeFetch({ data: { object: null } });
    expect(await createGraphqlHtlcReader(URL, fetchFn).fetchHtlc(ID)).toBeNull();
  });

  it('returns null for malformed data', async () => {
    expect(await createGraphqlHtlcReader(URL, fakeFetch({ data: { object: node({ balance: null }) } }).fetchFn).fetchHtlc(ID)).toBeNull();
    expect(await createGraphqlHtlcReader(URL, fakeFetch({ data: null }).fetchFn).fetchHtlc(ID)).toBeNull();
    expect(await createGraphqlHtlcReader(URL, fakeFetch('null').fetchFn).fetchHtlc(ID)).toBeNull();
  });

  it('throws on GraphQL errors and HTTP failures instead of reporting a missing object', async () => {
    const errors = { data: null, errors: [{ message: 'Failed to parse "SuiAddress"' }] };
    await expect(createGraphqlHtlcReader(URL, fakeFetch(errors).fetchFn).fetchHtlc('nope')).rejects.toThrow(/SuiAddress/);
    await expect(createGraphqlHtlcReader(URL, fakeFetch('bad gateway', 502).fetchFn).fetchHtlc(ID)).rejects.toThrow(/502/);
    await expect(createGraphqlHtlcReader(URL, fakeFetch('<html>', 200).fetchFn).fetchHtlc(ID)).rejects.toThrow();
  });
});
