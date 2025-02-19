import { bcs } from '@mysten/sui/bcs';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { toBase64 } from '@mysten/sui/utils';
import { describe, expect, it } from 'vitest';
import {
  bytesFromMoveJson,
  createSuiChain,
  findClaimInEvents,
  findClaimInTx,
  gasBudgetFromDryRun,
  graphqlUrlFor,
  isTxNotFoundError,
  normalizeGrpcError,
  parseClaimPage,
  toTxResult,
  type ClaimPage,
} from '../src/sui-chain';

const PKG = '0x' + '1'.repeat(64);
const OTHER_PKG = '0x' + '2'.repeat(64);
const HTLC = '0x' + 'ab'.repeat(32);
const OTHER_HTLC = '0x' + 'cd'.repeat(32);
const TESTNET = 'https://fullnode.testnet.sui.io:443';

/** Same shape as the RpcError thrown by the grpc-web transport: a string status code and a percent-encoded message. */
function rpcError(message: string, code: string): Error {
  const err = Object.assign(new Error(message), { code });
  err.name = 'RpcError';
  return err;
}

// Wire format of the Move `Locked` event (contracts/sui/sources/htlc.move).
const LockedBcs = bcs.struct('Locked', {
  htlc_id: bcs.Address,
  sender: bcs.Address,
  recipient: bcs.Address,
  amount: bcs.u64(),
  hash: bcs.vector(bcs.u8()),
  refund_after_ms: bcs.u64(),
});
const lockedBytes = LockedBcs.serialize({
  htlc_id: HTLC,
  sender: '0x5',
  recipient: '0x6',
  amount: 1_000n,
  hash: Array(32).fill(9),
  refund_after_ms: 1_700_000_000_000n,
}).toBytes();

// Wire format of the Move `Claimed` event.
const ClaimedBcs = bcs.struct('Claimed', { htlc_id: bcs.Address, preimage: bcs.vector(bcs.u8()) });
const PREIMAGE = Uint8Array.from({ length: 32 }, (_, i) => i);
const PREIMAGE_HEX = Buffer.from(PREIMAGE).toString('hex');
const claimedBytes = (htlcId: string) => ClaimedBcs.serialize({ htlc_id: htlcId, preimage: Array.from(PREIMAGE) }).toBytes();

describe('createSuiChain', () => {
  it('derives the bot address from a suiprivkey secret without touching the network', () => {
    const kp = Ed25519Keypair.generate();
    const chain = createSuiChain({ rpcUrl: TESTNET, privateKey: kp.getSecretKey(), packageId: PKG });
    expect(chain.address()).toBe(kp.toSuiAddress());
  });

  it('accepts any gRPC URL when the GraphQL URL is given explicitly', () => {
    const kp = Ed25519Keypair.generate();
    const chain = createSuiChain({
      rpcUrl: 'http://127.0.0.1:9000',
      graphqlUrl: 'http://127.0.0.1:9125/graphql',
      privateKey: kp.getSecretKey(),
      packageId: PKG,
    });
    expect(chain.address()).toBe(kp.toSuiAddress());
  });

  it('fails at construction when the GraphQL URL cannot be derived', () => {
    const kp = Ed25519Keypair.generate();
    expect(() => createSuiChain({ rpcUrl: 'http://127.0.0.1:9000', privateKey: kp.getSecretKey(), packageId: PKG })).toThrow(
      /graphqlUrl/,
    );
  });
});

describe('graphqlUrlFor', () => {
  it('maps the public fullnodes to their GraphQL endpoints', () => {
    expect(graphqlUrlFor(TESTNET)).toBe('https://graphql.testnet.sui.io/graphql');
    expect(graphqlUrlFor('https://fullnode.devnet.sui.io:443')).toBe('https://graphql.devnet.sui.io/graphql');
    expect(graphqlUrlFor('https://fullnode.mainnet.sui.io')).toBe('https://graphql.mainnet.sui.io/graphql');
  });

  it('throws a clear error for other URLs', () => {
    expect(() => graphqlUrlFor('http://127.0.0.1:9000')).toThrow(/cannot derive.*graphqlUrl/i);
    expect(() => graphqlUrlFor('not a url')).toThrow(/cannot derive.*graphqlUrl/i);
  });
});

describe('toTxResult', () => {
  it('maps a successful lock including the new HTLC id from the BCS Locked event', () => {
    const res = {
      digest: 'D1',
      effects: { status: { success: true } },
      events: {
        events: [
          { eventType: `${OTHER_PKG}::htlc::Locked`, contents: { value: new Uint8Array([1, 2, 3]) } },
          { eventType: `${PKG}::htlc::Locked`, contents: { value: lockedBytes } },
        ],
      },
    };
    expect(toTxResult(res, PKG)).toEqual({ digest: 'D1', success: true, error: null, htlcObjectId: HTLC });
  });

  it('accepts a short package id and the event type in any address form', () => {
    const res = {
      digest: 'D1',
      effects: { status: { success: true } },
      events: { events: [{ eventType: '0x0000000000000000000000000000000000000000000000000000000000000abc::htlc::Locked', contents: { value: lockedBytes } }] },
    };
    expect(toTxResult(res, '0xabc').htlcObjectId).toBe(HTLC);
  });

  it('maps a failed transaction', () => {
    const res = {
      digest: 'D2',
      effects: { status: { success: false, error: { description: 'MoveAbort(htlc, 4) in command 0' } } },
      events: { events: [] },
    };
    expect(toTxResult(res, PKG)).toEqual({ digest: 'D2', success: false, error: 'MoveAbort(htlc, 4) in command 0', htlcObjectId: null });
  });

  it('maps a failure without a description and a tx without events', () => {
    expect(toTxResult({ digest: 'D3', effects: { status: {} } }, PKG)).toEqual({
      digest: 'D3',
      success: false,
      error: 'transaction failed',
      htlcObjectId: null,
    });
  });

  it('throws instead of guessing when the response has no effects status', () => {
    expect(() => toTxResult({ digest: 'D4' }, PKG)).toThrow(/status/);
    expect(() => toTxResult(undefined, PKG)).toThrow();
  });
});

describe('findClaimInEvents', () => {
  const events = [
    { id: { txDigest: 'X' }, parsedJson: { htlc_id: '0xother', preimage: [1, 2] } },
    { id: { txDigest: 'Y' }, parsedJson: { htlc_id: '0xhtlc', preimage: Array(32).fill(7) } },
  ];

  it('returns the claim for the given HTLC', () => {
    expect(findClaimInEvents(events, '0xhtlc')).toEqual({ digest: 'Y', preimage: '07'.repeat(32) });
  });

  it('returns null when the HTLC has no claim', () => {
    expect(findClaimInEvents(events, '0xnone')).toBeNull();
  });

  it('skips events of the HTLC that carry no preimage (e.g. Locked or Refunded)', () => {
    const withLocked = [{ id: { txDigest: 'L' }, parsedJson: { htlc_id: '0xhtlc' } }, ...events];
    expect(findClaimInEvents(withLocked, '0xhtlc')).toEqual({ digest: 'Y', preimage: '07'.repeat(32) });
  });

  it('matches the HTLC id regardless of zero padding and case', () => {
    expect(findClaimInEvents(events, '0x' + 'HTLC'.padStart(64, '0'))).toEqual({
      digest: 'Y',
      preimage: '07'.repeat(32),
    });
  });
});

describe('parseClaimPage', () => {
  type TxNode = NonNullable<ClaimPage['transactions']>['nodes'][number];
  const claimed = (pkg: string, htlcId: string) => ({
    contents: { type: { repr: `${pkg}::htlc::Claimed` }, json: { htlc_id: htlcId, preimage: toBase64(PREIMAGE) } },
  });
  const locked = { contents: { type: { repr: `${PKG}::htlc::Locked` }, json: { htlc_id: HTLC } } };
  const junk = { contents: { type: { repr: `${OTHER_PKG}::spam::Junk` }, json: {} } };
  type EventNodes = NonNullable<TxNode['effects']>['events']['nodes'];
  const tx = (digest: string, nodes: EventNodes, hasNextPage = false): TxNode => ({
    digest,
    effects: { events: { pageInfo: { hasNextPage }, nodes } },
  });
  const page = (nodes: TxNode[], hasPreviousPage: boolean): ClaimPage => ({
    transactions: { pageInfo: { hasPreviousPage, startCursor: 'CURSOR' }, nodes },
  });

  it('returns the claim from a page with a matching Claimed event', () => {
    const p = page([tx('LOCK', [locked]), tx('CLAIM', [claimed(PKG, HTLC)])], true);
    expect(parseClaimPage(p, HTLC, PKG).claim).toEqual({ digest: 'CLAIM', preimage: PREIMAGE_HEX });
  });

  it('returns null and the cursor of the next (older) page when the page has no matching claim', () => {
    const p = page([tx('LOCK', [locked]), tx('OTHER', [claimed(PKG, OTHER_HTLC)]), tx('FAKE', [claimed(OTHER_PKG, HTLC)])], true);
    expect(parseClaimPage(p, HTLC, PKG)).toEqual({ claim: null, needsFullFetch: [], nextCursor: 'CURSOR' });
  });

  it('flags transactions whose events GraphQL cut off (or did not return) instead of reporting no claim', () => {
    // A claimer can emit 50+ junk events before Claimed; the first events page then has no Claimed event.
    const p = page([tx('LOCK', [locked]), tx('BIG', Array(50).fill(junk), true), { digest: 'NOEFFECTS', effects: null }], false);
    expect(parseClaimPage(p, HTLC, PKG)).toEqual({ claim: null, needsFullFetch: ['BIG', 'NOEFFECTS'], nextCursor: null });
  });

  it('still returns a claim seen in the visible part of a truncated transaction', () => {
    const p = page([tx('BIG', [claimed(PKG, HTLC), ...Array(49).fill(junk)], true)], false);
    expect(parseClaimPage(p, HTLC, PKG).claim).toEqual({ digest: 'BIG', preimage: PREIMAGE_HEX });
  });

  it('returns no cursor on the last page', () => {
    expect(parseClaimPage(page([], false), HTLC, PKG)).toEqual({ claim: null, needsFullFetch: [], nextCursor: null });
    expect(parseClaimPage({ transactions: null }, HTLC, PKG)).toEqual({ claim: null, needsFullFetch: [], nextCursor: null });
  });
});

describe('findClaimInTx', () => {
  const fullTx = (events: Array<{ eventType: string; contents: { value: Uint8Array } }>) => ({
    digest: 'FULL',
    effects: { status: { success: true } },
    events: { events },
  });

  it('BCS-decodes the Claimed event of a fully fetched gRPC transaction (htlc_id + 32-byte preimage)', () => {
    const junk = Array.from({ length: 60 }, () => ({ eventType: `${OTHER_PKG}::spam::Junk`, contents: { value: new Uint8Array([0]) } }));
    const res = fullTx([...junk, { eventType: `${PKG}::htlc::Claimed`, contents: { value: claimedBytes(HTLC) } }]);
    expect(findClaimInTx(res, HTLC, PKG)).toEqual({ digest: 'FULL', preimage: PREIMAGE_HEX });
  });

  it('ignores claims of other HTLCs, Claimed events of other packages and transactions without events', () => {
    expect(findClaimInTx(fullTx([{ eventType: `${PKG}::htlc::Claimed`, contents: { value: claimedBytes(OTHER_HTLC) } }]), HTLC, PKG)).toBeNull();
    expect(findClaimInTx(fullTx([{ eventType: `${OTHER_PKG}::htlc::Claimed`, contents: { value: claimedBytes(HTLC) } }]), HTLC, PKG)).toBeNull();
    expect(findClaimInTx({ digest: 'E', effects: { status: { success: true } } }, HTLC, PKG)).toBeNull();
  });
});

describe('isTxNotFoundError', () => {
  it("recognises the gRPC transaction-not-found error (encoded or decoded message)", () => {
    expect(isTxNotFoundError(rpcError('Transaction%2011111111111111111111111111111111%20not%20found', 'NOT_FOUND'))).toBe(true);
    expect(isTxNotFoundError(rpcError('Transaction 4DJfuRY7y2Y9gmatQMyXiMpLVy2awKFMxdSqgBkvmmig not found', 'NOT_FOUND'))).toBe(true);
  });

  it('does not treat other errors as not-found', () => {
    // JSON-RPC on public fullnodes is gone; its error must never look like "tx unknown".
    expect(isTxNotFoundError(new Error('Method not found. JSON-RPC on public fullnodes has been deprecated.'))).toBe(false);
    expect(isTxNotFoundError(rpcError('Method not found', 'NOT_FOUND'))).toBe(false);
    // An HTTP 404 (wrong URL) also surfaces as NOT_FOUND, with the HTTP status text.
    expect(isTxNotFoundError(rpcError('Not Found', 'NOT_FOUND'))).toBe(false);
    expect(isTxNotFoundError(rpcError('Object 0x6 not found', 'NOT_FOUND'))).toBe(false);
    // Only the transport's error counts, not a look-alike message.
    expect(isTxNotFoundError(new Error('Transaction ABC not found'))).toBe(false);
    expect(isTxNotFoundError(rpcError('Transaction ABC not found', 'UNKNOWN'))).toBe(false);
    // Timeouts, rate limits and garbage.
    expect(isTxNotFoundError(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))).toBe(false);
    expect(isTxNotFoundError(rpcError('deadline exceeded', 'DEADLINE_EXCEEDED'))).toBe(false);
    expect(isTxNotFoundError(rpcError('Too Many Requests', 'RESOURCE_EXHAUSTED'))).toBe(false);
    expect(isTxNotFoundError(rpcError('fetch failed', 'INTERNAL'))).toBe(false);
    expect(isTxNotFoundError(undefined)).toBe(false);
    expect(isTxNotFoundError({ code: 'NOT_FOUND' })).toBe(false);
  });
});

describe('normalizeGrpcError', () => {
  it('percent-decodes gRPC messages in place so callers can match them (e.g. stale inputs)', () => {
    const err = rpcError(
      'Error%20checking%20transaction%20input%20objects:%20Transaction%20needs%20to%20be%20rebuilt%20because%20object%200x02%20version%200x3d1239%20is%20unavailable%20for%20consumption',
      'INVALID_ARGUMENT',
    );
    const out = normalizeGrpcError(err);
    expect(out).toBe(err);
    expect((out as Error).message).toBe(
      'Error checking transaction input objects: Transaction needs to be rebuilt because object 0x02 version 0x3d1239 is unavailable for consumption',
    );
    expect((out as Error & { code: string }).code).toBe('INVALID_ARGUMENT');
  });

  it('leaves other errors and undecodable messages alone', () => {
    const plain = new Error('a%20b');
    expect((normalizeGrpcError(plain) as Error).message).toBe('a%20b');
    expect((normalizeGrpcError(rpcError('100%', 'UNKNOWN')) as Error).message).toBe('100%');
    expect(normalizeGrpcError('boom')).toBe('boom');
  });
});

describe('gasBudgetFromDryRun', () => {
  it('adds a safety overhead to computation and storage costs', () => {
    expect(gasBudgetFromDryRun({ computationCost: 1_000_000n, storageCost: 1_976_000n, storageRebate: 0n }, 1_000n)).toBe(3_976_000n);
  });

  it('never goes below computation plus overhead when the rebate exceeds storage', () => {
    expect(gasBudgetFromDryRun({ computationCost: '1000000', storageCost: '1976000', storageRebate: '2963704' }, 1_000n)).toBe(2_000_000n);
  });
});

describe('bytesFromMoveJson', () => {
  it('decodes arrays and base64', () => {
    expect(Array.from(bytesFromMoveJson([1, 2]))).toEqual([1, 2]);
    expect(Array.from(bytesFromMoveJson(toBase64(Uint8Array.from([3, 4]))))).toEqual([3, 4]);
    expect(() => bytesFromMoveJson(5)).toThrow(/vector<u8>/);
  });
});
