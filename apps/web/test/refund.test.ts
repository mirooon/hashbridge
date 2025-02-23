import { buildWitnessScript, htlcAddress } from '@hashbridge/core/htlc-script';
import { btcKeyFromPrivateKeyHex } from '@hashbridge/core/keys';
import { bytesToHex, hexToBytes } from '@hashbridge/core/secret';
import type { BtcChain, RecoveryFile, SwapView, Utxo } from '@hashbridge/core/types';
import { describe, expect, it } from 'vitest';
import { blocksUntilRefund, executeRefund, importRecoveryFile, refundOffered } from '../src/lib/refund';
import { createSwapStorage, memoryStore } from '../src/lib/storage';

const REFUND_PRIV = '00'.repeat(31) + '02';
const refundKey = btcKeyFromPrivateKeyHex(REFUND_PRIV);
const HASH = '4bb06f8e4e3a7715d201d573d0aa423762e55dabd61a2c02278fa56cc6d294e0';
const BOT_PUB = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const ws = buildWitnessScript({ hash: hexToBytes(HASH), claimPubkey: hexToBytes(BOT_PUB), refundPubkey: refundKey.publicKey, locktime: 241_872 });
const recovery: RecoveryFile = {
  version: 1, swapId: 'swap-1', secret: '07'.repeat(32), hash: HASH, refundPrivkey: REFUND_PRIV, refundPubkey: bytesToHex(refundKey.publicKey),
  botPubkey: BOT_PUB, locktime: 241_872, witnessScript: bytesToHex(ws), htlcAddress: htlcAddress(ws), suiRecipient: '0x' + 'a'.repeat(64),
  btcSats: 100_000, suiAmount: '12338000000', quoteExpiresAt: 1, apiUrl: 'http://localhost:8787', createdAt: 0,
};
const DEST = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';

function fakeBtc(tip: number, utxos: Utxo[]): BtcChain & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    tipHeight: async () => tip,
    addressUtxos: async () => utxos,
    broadcast: async (hex) => { sent.push(hex); return 'refund-txid'; },
    feeRate: async () => 2,
  };
}
const utxo = (txid: string, value: number): Utxo => ({ txid, vout: 0, value, confirmed: true, blockHeight: 1 });

describe('refundOffered', () => {
  const v = (status: SwapView['status']) => ({ status }) as SwapView;
  it('offers refunds for failed swaps and stalled ones', () => {
    expect(refundOffered(v('REJECTED'), 0, 1)).toBe(true);
    expect(refundOffered(v('EXPIRED'), 0, 1)).toBe(true);
    expect(refundOffered(v('SUI_REFUNDED'), 0, 1)).toBe(true);
    expect(refundOffered(v('DEPOSIT_SEEN'), 0, 600_001)).toBe(true);
    expect(refundOffered(null, 0, 600_001)).toBe(true);
  });

  it('does not offer refunds while the swap is healthy', () => {
    expect(refundOffered(v('DEPOSIT_SEEN'), 0, 599_999)).toBe(false);
    expect(refundOffered(v('SUI_LOCKED'), 0, 10_000_000)).toBe(false);
    expect(refundOffered(v('BTC_CLAIMED'), 0, 10_000_000)).toBe(false);
  });
});

describe('blocksUntilRefund', () => {
  it('counts blocks until the locktime', () => {
    expect(blocksUntilRefund(241_872, 241_800)).toBe(72);
    expect(blocksUntilRefund(241_872, 241_872)).toBe(0);
    expect(blocksUntilRefund(241_872, 241_900)).toBe(0);
  });
});

describe('executeRefund', () => {
  it('refuses before the locktime', async () => {
    await expect(executeRefund(recovery, DEST, fakeBtc(241_871, [utxo('aa'.repeat(32), 100_000)]))).rejects.toThrow(/1 block/);
  });

  it('reports when there is nothing to refund', async () => {
    await expect(executeRefund(recovery, DEST, fakeBtc(241_900, []))).rejects.toThrow(/Nothing to refund/);
  });

  it('refunds every UTXO at the HTLC address', async () => {
    const btc = fakeBtc(241_872, [utxo('aa'.repeat(32), 60_000), utxo('bb'.repeat(32), 40_000)]);
    expect(await executeRefund(recovery, DEST, btc)).toEqual({ txid: 'refund-txid' });
    const hex = btc.sent[0]!;
    expect(hex.slice(8, 12)).toBe('0001'); // segwit marker + flag
    expect(hex.slice(12, 14)).toBe('02'); // two inputs
    expect(hex.endsWith('d0b00300')).toBe(true); // nLockTime 241872, little endian
  });

  it('rejects a mainnet destination', async () => {
    await expect(
      executeRefund(recovery, 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', fakeBtc(241_872, [utxo('aa'.repeat(32), 100_000)])),
    ).rejects.toThrow(/destination/);
  });
});

describe('importRecoveryFile', () => {
  it('saves a consistent recovery file', () => {
    const storage = createSwapStorage(memoryStore());
    const state = importRecoveryFile(JSON.stringify(recovery), storage);
    expect(state).toEqual({ recovery, recoveryDownloaded: true, revealedAt: null, revealedHtlcId: null });
    expect(storage.load('swap-1')?.recovery.swapId).toBe('swap-1');
  });

  it('keeps the reveal marker of a swap already stored in this browser', () => {
    const storage = createSwapStorage(memoryStore());
    storage.save({ recovery, recoveryDownloaded: true, revealedAt: 42, revealedHtlcId: '0xh' });
    expect(importRecoveryFile(JSON.stringify(recovery), storage)).toEqual({ recovery, recoveryDownloaded: true, revealedAt: 42, revealedHtlcId: '0xh' });
    expect(storage.load('swap-1')?.revealedAt).toBe(42);
  });

  it('drops a stored reveal marker that belongs to another secret under the same swap id', () => {
    const storage = createSwapStorage(memoryStore());
    storage.save({ recovery: { ...recovery, hash: 'cd'.repeat(32) }, recoveryDownloaded: true, revealedAt: 42, revealedHtlcId: '0xh' });
    expect(importRecoveryFile(JSON.stringify(recovery), storage)).toEqual({ recovery, recoveryDownloaded: true, revealedAt: null, revealedHtlcId: null });
  });

  it('rejects files whose secret or address do not add up', () => {
    const storage = createSwapStorage(memoryStore());
    expect(() => importRecoveryFile(JSON.stringify({ ...recovery, secret: '08'.repeat(32) }), storage)).toThrow(/secret/);
    expect(() => importRecoveryFile(JSON.stringify({ ...recovery, htlcAddress: DEST }), storage)).toThrow(/address/);
  });
});
