import type { RecoveryFile, SwapView, Utxo } from '@hashbridge/core/types';
import { describe, expect, it } from 'vitest';
import { CLAIM_FALLBACK_MS, minExpectedMist, nextClaimAction, paidSatsFrom, timelineItems } from '../src/lib/claim-flow';

const view = (over: Partial<SwapView> = {}): SwapView => ({
  swapId: 'swap-1', status: 'AWAITING_DEPOSIT', createdAt: 0, hash: 'ab'.repeat(32), htlcAddress: 'tb1q', witnessScript: '51',
  locktime: 241_872, btcSats: 100_000, suiRecipient: '0x' + 'a'.repeat(64), suiAmount: '12338000000', quoteExpiresAt: 1,
  depositTxid: null, depositSats: null, htlcObjectId: null, suiDeadlineMs: null, lockDigest: null, claimDigest: null,
  btcClaimTxid: null, refundDigest: null, rejectReason: null, ...over,
});

describe('nextClaimAction', () => {
  it('waits until SUI is locked', () => {
    expect(nextClaimAction(null, null, 0)).toEqual({ kind: 'wait' });
    expect(nextClaimAction(view({ status: 'DEPOSIT_SEEN' }), null, 0)).toEqual({ kind: 'wait' });
  });

  it('verifies and claims once the HTLC exists', () => {
    expect(nextClaimAction(view({ status: 'SUI_LOCKED', htlcObjectId: '0xh' }), null, 0)).toEqual({ kind: 'verify-and-claim', htlcObjectId: '0xh' });
  });

  it('offers the fallback 30 s after sending the secret', () => {
    const locked = view({ status: 'SUI_LOCKED', htlcObjectId: '0xh' });
    expect(nextClaimAction(locked, 1_000, 1_000 + CLAIM_FALLBACK_MS - 1)).toEqual({ kind: 'wait' });
    expect(nextClaimAction(locked, 1_000, 1_000 + CLAIM_FALLBACK_MS)).toEqual({ kind: 'show-fallback' });
  });

  it('is done once SUI was claimed', () => {
    expect(nextClaimAction(view({ status: 'SUI_CLAIMED' }), 1, 2)).toEqual({ kind: 'done' });
    expect(nextClaimAction(view({ status: 'BTC_CLAIMED' }), null, 2)).toEqual({ kind: 'done' });
  });
});

describe('minExpectedMist', () => {
  const recovery = { btcSats: 100_000, suiAmount: '12338000000' } as RecoveryFile;
  it('scales the quote to the actual deposit, capped at the quoted amount', () => {
    expect(minExpectedMist(recovery, 100_000)).toBe(12_338_000_000n);
    expect(minExpectedMist(recovery, 50_000)).toBe(6_169_000_000n);
    expect(minExpectedMist(recovery, 500_000)).toBe(12_338_000_000n);
  });
});

describe('paidSatsFrom', () => {
  const utxo = (value: number): Utxo => ({ txid: 'aa', vout: 0, value, confirmed: false, blockHeight: null });

  it('sums the chain UTXOs and ignores the bot-reported amount when they are given', () => {
    expect(paidSatsFrom([utxo(60_000), utxo(40_000)], 1)).toBe(100_000);
    expect(paidSatsFrom([utxo(5_000)], 100_000)).toBe(5_000);
  });

  it('falls back to the bot-reported deposit without chain data', () => {
    expect(paidSatsFrom(null, 70_000)).toBe(70_000);
  });

  it('is null (fail closed) when nothing was verifiably paid', () => {
    expect(paidSatsFrom([], 100_000)).toBeNull();
    expect(paidSatsFrom(null, null)).toBeNull();
    expect(paidSatsFrom(null, 0)).toBeNull();
    expect(paidSatsFrom([utxo(0)], null)).toBeNull();
  });
});

describe('timelineItems', () => {
  it('marks done steps, the next active step and pending ones', () => {
    const items = timelineItems(view({ status: 'SUI_LOCKED', depositTxid: 'aa', lockDigest: 'L' }));
    expect(items.map((i) => [i.label, i.state])).toEqual([
      ['Deposit in mempool', 'done'],
      ['SUI locked by the bot', 'done'],
      ['Secret revealed, SUI received', 'active'],
      ['Bot claimed the BTC', 'pending'],
    ]);
    expect(items[0]!.href).toBe('https://mempool.space/signet/tx/aa');
    expect(items[1]!.href).toBe('https://suiscan.xyz/testnet/tx/L');
  });

  it('marks everything done after the BTC claim', () => {
    const items = timelineItems(view({ status: 'BTC_CLAIMED', depositTxid: 'aa', lockDigest: 'L', claimDigest: 'C', btcClaimTxid: 'bb' }));
    expect(items.every((i) => i.state === 'done')).toBe(true);
  });
});
