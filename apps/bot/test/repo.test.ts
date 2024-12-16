import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openSwapRepo } from '../src/repo';
import type { SwapRecord } from '../src/types';

function record(over: Partial<SwapRecord> = {}): SwapRecord {
  return {
    swapId: 'swap-1', status: 'AWAITING_DEPOSIT', createdAt: 1, hash: 'ab'.repeat(32), htlcAddress: 'tb1qhtlc',
    witnessScript: '51', locktime: 100, btcSats: 100_000, suiRecipient: '0x' + 'a'.repeat(64), suiAmount: '1',
    quoteExpiresAt: 2, depositTxid: null, depositSats: null, htlcObjectId: null, suiDeadlineMs: null,
    lockDigest: null, claimDigest: null, btcClaimTxid: null, refundDigest: null, rejectReason: null,
    refundPubkey: '03' + '33'.repeat(32), depositVout: null, depositFirstSeenAt: null, preimage: null,
    btcClaimTxHex: null, pendingTx: null, ...over,
  };
}

describe('openSwapRepo', () => {
  it('stores and reads a swap', () => {
    const repo = openSwapRepo(':memory:');
    repo.insert(record());
    expect(repo.get('swap-1')).toEqual(record());
    expect(repo.get('nope')).toBeUndefined();
  });

  it('merges updates and keeps nested pending txs', () => {
    const repo = openSwapRepo(':memory:');
    repo.insert(record());
    const pendingTx = { kind: 'lock' as const, digest: 'D', bytes: 'AA==', signature: 'c2ln' };
    const updated = repo.update('swap-1', { status: 'DEPOSIT_SEEN', depositSats: 5, pendingTx });
    expect(updated.status).toBe('DEPOSIT_SEEN');
    expect(repo.get('swap-1')).toMatchObject({ status: 'DEPOSIT_SEEN', depositSats: 5, pendingTx, btcSats: 100_000 });
  });

  it('cannot rename a swap through update', () => {
    const repo = openSwapRepo(':memory:');
    repo.insert(record());
    const updated = repo.update('swap-1', { swapId: 'other' });
    expect(updated.swapId).toBe('swap-1');
    expect(repo.get('swap-1')?.swapId).toBe('swap-1');
    expect(repo.get('other')).toBeUndefined();
  });

  it('throws when updating an unknown swap', () => {
    expect(() => openSwapRepo(':memory:').update('nope', {})).toThrow(/not found/);
  });

  it('finds swaps by hash and rejects duplicate hashes', () => {
    const repo = openSwapRepo(':memory:');
    repo.insert(record());
    expect(repo.findByHash('ab'.repeat(32))?.swapId).toBe('swap-1');
    expect(() => repo.insert(record({ swapId: 'swap-2' }))).toThrow();
  });

  it('lists only non-terminal swaps', () => {
    const repo = openSwapRepo(':memory:');
    repo.insert(record({ swapId: 'a', hash: '01'.repeat(32) }));
    repo.insert(record({ swapId: 'b', hash: '02'.repeat(32), status: 'SUI_LOCKED' }));
    repo.insert(record({ swapId: 'c', hash: '03'.repeat(32), status: 'BTC_CLAIMED' }));
    repo.insert(record({ swapId: 'd', hash: '04'.repeat(32), status: 'REJECTED' }));
    expect(repo.listActive().map((s) => s.swapId)).toEqual(['a', 'b']);
  });

  it('persists to disk across reopen', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'hashbridge-')), 'test.db');
    openSwapRepo(path).insert(record());
    expect(openSwapRepo(path).get('swap-1')?.hash).toBe('ab'.repeat(32));
  });
});
