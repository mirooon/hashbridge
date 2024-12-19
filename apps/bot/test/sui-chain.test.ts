import type { SuiTransactionBlockResponse } from '@mysten/sui/client';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { toBase64 } from '@mysten/sui/utils';
import { describe, expect, it } from 'vitest';
import { bytesFromMoveJson, createSuiChain, findClaimInEvents, isTxNotFoundError, toTxResult } from '../src/sui-chain';

const PKG = '0x' + '1'.repeat(64);
const asResponse = (v: unknown) => v as SuiTransactionBlockResponse;

describe('createSuiChain', () => {
  it('derives the bot address from a suiprivkey secret without touching the network', () => {
    const kp = Ed25519Keypair.generate();
    const chain = createSuiChain({ rpcUrl: 'http://127.0.0.1:1', privateKey: kp.getSecretKey(), packageId: PKG });
    expect(chain.address()).toBe(kp.toSuiAddress());
  });
});

describe('toTxResult', () => {
  it('maps a successful lock including the new HTLC id', () => {
    const res = asResponse({
      digest: 'D1',
      effects: { status: { status: 'success' } },
      events: [{ type: `${PKG}::htlc::Locked`, parsedJson: { htlc_id: '0xhtlc' } }],
    });
    expect(toTxResult(res, PKG)).toEqual({ digest: 'D1', success: true, error: null, htlcObjectId: '0xhtlc' });
  });

  it('maps a failed transaction', () => {
    const res = asResponse({
      digest: 'D2',
      effects: { status: { status: 'failure', error: 'MoveAbort(htlc, 4)' } },
      events: [],
    });
    expect(toTxResult(res, PKG)).toEqual({ digest: 'D2', success: false, error: 'MoveAbort(htlc, 4)', htlcObjectId: null });
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
});

describe('isTxNotFoundError', () => {
  it('recognises the RPC transaction-not-found error', () => {
    expect(isTxNotFoundError(new Error('Could not find the referenced transaction [TransactionDigest(ABC)].'))).toBe(true);
    expect(isTxNotFoundError(new Error('transaction not found'))).toBe(true);
    expect(isTxNotFoundError(new Error('Transaction does not exist'))).toBe(true);
  });

  it('does not treat timeouts, rate limits or garbage as not-found', () => {
    expect(isTxNotFoundError(new Error('The user aborted a request.'))).toBe(false);
    expect(isTxNotFoundError(new Error('JSON-RPC error: 429 Too Many Requests'))).toBe(false);
    expect(isTxNotFoundError(new Error('fetch failed'))).toBe(false);
    expect(isTxNotFoundError(undefined)).toBe(false);
    expect(isTxNotFoundError({ code: 404 })).toBe(false);
  });
});

describe('bytesFromMoveJson', () => {
  it('decodes arrays and base64', () => {
    expect(Array.from(bytesFromMoveJson([1, 2]))).toEqual([1, 2]);
    expect(Array.from(bytesFromMoveJson(toBase64(Uint8Array.from([3, 4]))))).toEqual([3, 4]);
    expect(() => bytesFromMoveJson(5)).toThrow(/vector<u8>/);
  });
});
