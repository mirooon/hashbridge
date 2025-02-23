import type { RecoveryFile } from '@hashbridge/core/types';
import { describe, expect, it } from 'vitest';
import { createSwapStorage, memoryStore, parseRecoveryFile, recoveryFileName, serializeRecoveryFile } from '../src/lib/storage';

const recovery: RecoveryFile = {
  version: 1, swapId: 'swap-1', secret: '07'.repeat(32), hash: 'ab'.repeat(32), refundPrivkey: '01'.repeat(32),
  refundPubkey: '02' + '11'.repeat(32), botPubkey: '03' + '22'.repeat(32), locktime: 241_872, witnessScript: '6382',
  htlcAddress: 'tb1qhtlc', suiRecipient: '0x' + 'a'.repeat(64), btcSats: 100_000, suiAmount: '12338000000',
  quoteExpiresAt: 2, apiUrl: 'http://localhost:8787', createdAt: 1,
};

describe('createSwapStorage', () => {
  it('saves, loads and updates swaps', () => {
    const storage = createSwapStorage(memoryStore());
    storage.save({ recovery, recoveryDownloaded: false, revealedAt: null, revealedHtlcId: null });
    expect(storage.load('swap-1')?.recovery).toEqual(recovery);
    expect(storage.update('swap-1', { revealedAt: 5, revealedHtlcId: '0xh' })).toMatchObject({ revealedAt: 5, revealedHtlcId: '0xh' });
    expect(storage.load('swap-1')).toEqual({ recovery, recoveryDownloaded: false, revealedAt: 5, revealedHtlcId: '0xh' });
  });

  it('reads states stored before the reveal marker existed', () => {
    const store = memoryStore();
    store.setItem('hashbridge:swap:swap-1', JSON.stringify({ recovery, recoveryDownloaded: true, claimSentAt: null }));
    store.setItem('hashbridge:swap:swap-2', JSON.stringify({ recovery: { ...recovery, swapId: 'swap-2' }, recoveryDownloaded: true, claimSentAt: 7 }));
    const storage = createSwapStorage(store);
    expect(storage.load('swap-1')).toEqual({ recovery, recoveryDownloaded: true, revealedAt: null, revealedHtlcId: null });
    // An old claimSentAt means the secret was sent: it counts as the reveal.
    expect(storage.load('swap-2')).toMatchObject({ revealedAt: 7, revealedHtlcId: null });
    expect(storage.update('swap-2', { recoveryDownloaded: true })).not.toHaveProperty('claimSentAt');
  });

  it('returns null for unknown or corrupt entries', () => {
    const store = memoryStore();
    store.setItem('hashbridge:swap:bad', '{not json');
    const storage = createSwapStorage(store);
    expect(storage.load('missing')).toBeNull();
    expect(storage.load('bad')).toBeNull();
    expect(storage.update('missing', { revealedAt: 1 })).toBeNull();
  });
});

describe('recovery file', () => {
  it('round-trips through JSON', () => {
    expect(parseRecoveryFile(serializeRecoveryFile(recovery))).toEqual(recovery);
    expect(recoveryFileName(recovery)).toBe('hashbridge-recovery-swap-1.json');
  });

  it('names the first invalid field', () => {
    expect(() => parseRecoveryFile('nope')).toThrow('Invalid recovery file: not JSON');
    expect(() => parseRecoveryFile(JSON.stringify({ ...recovery, version: 2 }))).toThrow('Invalid recovery file: version');
    expect(() => parseRecoveryFile(JSON.stringify({ ...recovery, secret: 'xyz' }))).toThrow('Invalid recovery file: secret');
    expect(() => parseRecoveryFile(JSON.stringify({ ...recovery, suiRecipient: '0x12' }))).toThrow('Invalid recovery file: suiRecipient');
  });
});
