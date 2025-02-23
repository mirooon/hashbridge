import type { RecoveryFile, SwapView, Utxo } from '@hashbridge/core/types';
import { describe, expect, it } from 'vitest';
import {
  CHAIN_CONFIRM_MS,
  CLAIM_FALLBACK_MS,
  CLAIM_RETRY_MS,
  SPLIT_DEPOSIT_PROBLEM,
  chainExists,
  chainWatch,
  minExpectedMist,
  nextChainReading,
  nextClaimAction,
  paidSatsFrom,
  postRevealState,
  revealProblems,
  shouldResendClaim,
  timelineItems,
  type ChainReading,
  type ChainWatch,
} from '../src/lib/claim-flow';
import type { HtlcOnChain } from '../src/lib/sui-verify';

const view = (over: Partial<SwapView> = {}): SwapView => ({
  swapId: 'swap-1', status: 'AWAITING_DEPOSIT', createdAt: 0, hash: 'ab'.repeat(32), htlcAddress: 'tb1q', witnessScript: '51',
  locktime: 241_872, btcSats: 100_000, suiRecipient: '0x' + 'a'.repeat(64), suiAmount: '12338000000', quoteExpiresAt: 1,
  depositTxid: null, depositSats: null, htlcObjectId: null, suiDeadlineMs: null, lockDigest: null, claimDigest: null,
  btcClaimTxid: null, refundDigest: null, rejectReason: null, ...over,
});

describe('nextClaimAction', () => {
  it('waits until SUI is locked', () => {
    expect(nextClaimAction(null, null)).toEqual({ kind: 'wait' });
    expect(nextClaimAction(view({ status: 'DEPOSIT_SEEN' }), null)).toEqual({ kind: 'wait' });
    expect(nextClaimAction(view({ status: 'SUI_LOCKED' }), null)).toEqual({ kind: 'wait' });
  });

  it('verifies and claims once the HTLC exists', () => {
    expect(nextClaimAction(view({ status: 'SUI_LOCKED', htlcObjectId: '0xh' }), null)).toEqual({ kind: 'verify-and-claim', htlcObjectId: '0xh' });
  });

  it('never verifies or reveals again once the secret was revealed', () => {
    expect(nextClaimAction(view({ status: 'SUI_LOCKED', htlcObjectId: '0xh' }), 1_000)).toEqual({ kind: 'wait' });
  });

  it('does not reveal on a bot-reported claim', () => {
    expect(nextClaimAction(view({ status: 'SUI_CLAIMED', htlcObjectId: '0xh' }), null)).toEqual({ kind: 'wait' });
  });
});

describe('chainWatch', () => {
  const reveal = { at: 5_000, htlcObjectId: '0xverified' };

  it('watches the verified HTLC from the reveal on, whatever the bot reports', () => {
    expect(chainWatch(reveal, view({ status: 'SUI_CLAIMED', htlcObjectId: '0xfake' }))).toEqual({ id: '0xverified', since: 5_000 });
    expect(chainWatch(reveal, null)).toEqual({ id: '0xverified', since: 5_000 });
  });

  it("falls back to the bot's id only for an old reveal stored without the verified id", () => {
    expect(chainWatch({ at: 5_000, htlcObjectId: null }, view({ status: 'SUI_LOCKED', htlcObjectId: '0xh' }))).toEqual({ id: '0xh', since: 5_000 });
    expect(chainWatch({ at: 5_000, htlcObjectId: null }, null)).toBeNull();
  });

  it('before the reveal watches only a bot-reported claim', () => {
    expect(chainWatch(null, view({ status: 'SUI_CLAIMED', htlcObjectId: '0xh' }))).toEqual({ id: '0xh', since: 0 });
    expect(chainWatch(null, view({ status: 'BTC_CLAIMED', htlcObjectId: '0xh' }))).toEqual({ id: '0xh', since: 0 });
    expect(chainWatch(null, view({ status: 'SUI_LOCKED', htlcObjectId: '0xh' }))).toBeNull();
    expect(chainWatch(null, view({ status: 'SUI_CLAIMED' }))).toBeNull();
    expect(chainWatch(null, null)).toBeNull();
  });
});

describe('nextChainReading', () => {
  const watch: ChainWatch = { id: '0xh', since: 5_000 };
  const read = (exists: boolean | null, at: number, id = '0xh') => ({ id, exists, at });
  const apply = (reads: Array<ReturnType<typeof read>>, w: ChainWatch | null = watch, start: ChainReading | null = null) =>
    reads.reduce<ChainReading | null>((prev, r) => nextChainReading(prev, r, w), start);

  it('records an existing object', () => {
    expect(chainExists(apply([read(true, 6_000)]), watch)).toBe(true);
  });

  it('needs two consecutive null reads at least 2 s apart before the object counts as gone', () => {
    expect(chainExists(apply([read(false, 6_000)]), watch)).toBeNull();
    expect(chainExists(apply([read(false, 6_000), read(false, 6_000 + CHAIN_CONFIRM_MS - 1)]), watch)).toBeNull();
    expect(chainExists(apply([read(false, 6_000), read(false, 6_000 + CHAIN_CONFIRM_MS)]), watch)).toBe(false);
  });

  it('restarts the count when a read in between sees the object or fails', () => {
    expect(chainExists(apply([read(false, 6_000), read(true, 8_000), read(false, 10_000)]), watch)).toBeNull();
    expect(chainExists(apply([read(false, 6_000), read(null, 8_000), read(false, 10_000)]), watch)).toBeNull();
    expect(chainExists(apply([read(false, 6_000), read(null, 8_000), read(false, 10_000), read(false, 12_000)]), watch)).toBe(false);
  });

  it('keeps a confirmed disappearance (a deleted object does not come back)', () => {
    expect(chainExists(apply([read(false, 6_000), read(false, 8_000), read(true, 10_000), read(null, 12_000)]), watch)).toBe(false);
  });

  it('ignores a reading of another object', () => {
    expect(apply([read(false, 6_000, '0xfake'), read(false, 8_000, '0xfake')])).toBeNull();
    const seen = apply([read(true, 6_000)]);
    expect(nextChainReading(seen, read(false, 8_000, '0xfake'), watch)).toBe(seen);
    expect(nextChainReading(null, read(false, 8_000), null)).toBeNull();
  });

  it('discards readings taken before the reveal, also when they arrive after it', () => {
    const before: ChainWatch = { id: '0xh', since: 0 };
    const gone = apply([read(false, 1_000), read(false, 3_000)], before);
    expect(chainExists(gone, before)).toBe(false);
    // After the reveal at 5_000 the same reading no longer counts, and a late one taken at 4_000 is dropped.
    expect(chainExists(gone, watch)).toBeNull();
    expect(nextChainReading(null, read(false, 4_000), watch)).toBeNull();
    expect(nextChainReading(null, read(false, 5_000), watch)).toBeNull();
    expect(chainExists(apply([read(false, 4_000), read(false, 6_000)]), watch)).toBeNull();
    // Readings of the new epoch start from scratch even when the old reading said gone.
    expect(chainExists(apply([read(false, 6_000)], watch, gone), watch)).toBeNull();
    expect(chainExists(apply([read(false, 6_000), read(false, 8_000)], watch, gone), watch)).toBe(false);
  });
});

describe('postRevealState', () => {
  const revealedAt = 1_000;
  const watch: ChainWatch = { id: '0xh', since: revealedAt };
  const reading = (exists: boolean | null, over: Partial<ChainReading> = {}): ChainReading => ({
    id: '0xh', since: revealedAt, exists, missingSince: null, ...over,
  });

  it('waits for 30 s after the reveal', () => {
    expect(postRevealState({ revealedAt, now: revealedAt + CLAIM_FALLBACK_MS - 1, reading: reading(true), watch })).toBe('waiting');
    expect(postRevealState({ revealedAt, now: revealedAt + CLAIM_FALLBACK_MS - 1, reading: null, watch })).toBe('waiting');
  });

  it('offers the fallback 30 s after the reveal while the HTLC is still on-chain or its state is unknown', () => {
    expect(postRevealState({ revealedAt, now: revealedAt + CLAIM_FALLBACK_MS, reading: reading(true), watch })).toBe('show-fallback');
    expect(postRevealState({ revealedAt, now: revealedAt + 10 * CLAIM_FALLBACK_MS, reading: reading(null), watch })).toBe('show-fallback');
    expect(postRevealState({ revealedAt, now: revealedAt + 10 * CLAIM_FALLBACK_MS, reading: null, watch })).toBe('show-fallback');
  });

  it('counts the claim as done only when the watched HTLC object is confirmed gone', () => {
    expect(postRevealState({ revealedAt, now: revealedAt + 1, reading: reading(false), watch })).toBe('claimed-on-chain');
    expect(postRevealState({ revealedAt, now: revealedAt + CLAIM_FALLBACK_MS, reading: reading(false), watch })).toBe('claimed-on-chain');
    const before: ChainWatch = { id: '0xh', since: 0 };
    expect(postRevealState({ revealedAt: null, now: 0, reading: reading(false, { since: 0 }), watch: before })).toBe('claimed-on-chain');
  });

  it('ignores a disappearance seen for another object or before the reveal', () => {
    const late = revealedAt + CLAIM_FALLBACK_MS;
    expect(postRevealState({ revealedAt, now: late, reading: reading(false, { id: '0xfake' }), watch })).toBe('show-fallback');
    expect(postRevealState({ revealedAt, now: late, reading: reading(false, { since: 0 }), watch })).toBe('show-fallback');
    expect(postRevealState({ revealedAt, now: late, reading: reading(false), watch: null })).toBe('show-fallback');
  });

  it('defeats a fake claim reported before the reveal', () => {
    // The bot reports SUI_CLAIMED with a fake id before the reveal: the fake object reads as gone twice.
    const fakeWatch = chainWatch(null, view({ status: 'SUI_CLAIMED', htlcObjectId: '0xfake' }));
    let r: ChainReading | null = null;
    r = nextChainReading(r, { id: '0xfake', exists: false, at: 100 }, fakeWatch);
    r = nextChainReading(r, { id: '0xfake', exists: false, at: 2_100 }, fakeWatch);
    expect(chainExists(r, fakeWatch)).toBe(false);
    // Then it reports the real HTLC; the browser verifies and reveals at 5_000; a late fake read arrives afterwards.
    const realWatch = chainWatch({ at: 5_000, htlcObjectId: '0xreal' }, view({ status: 'SUI_CLAIMED', htlcObjectId: '0xfake' }));
    r = nextChainReading(r, { id: '0xfake', exists: false, at: 4_100 }, realWatch);
    expect(postRevealState({ revealedAt: 5_000, now: 5_000 + CLAIM_FALLBACK_MS, reading: r, watch: realWatch })).toBe('show-fallback');
    r = nextChainReading(r, { id: '0xreal', exists: true, at: 7_000 }, realWatch);
    expect(postRevealState({ revealedAt: 5_000, now: 5_000 + CLAIM_FALLBACK_MS, reading: r, watch: realWatch })).toBe('show-fallback');
  });

  it('never offers the fallback before a reveal', () => {
    expect(postRevealState({ revealedAt: null, now: 10 * CLAIM_FALLBACK_MS, reading: null, watch: null })).toBe('waiting');
  });
});

describe('shouldResendClaim', () => {
  const base = { revealedAt: 1_000, claimAccepted: false, state: 'waiting' as const, now: 10_000, lastAttemptAt: 10_000 - CLAIM_RETRY_MS };

  it('re-sends a failed claim every 2 s after the reveal, whatever the bot status', () => {
    expect(shouldResendClaim(base)).toBe(true);
    expect(shouldResendClaim({ ...base, state: 'show-fallback' })).toBe(true);
    expect(shouldResendClaim({ ...base, lastAttemptAt: base.now - CLAIM_RETRY_MS + 1 })).toBe(false);
  });

  it('stops once the bot accepted the claim or the claim is on-chain', () => {
    expect(shouldResendClaim({ ...base, claimAccepted: true })).toBe(false);
    expect(shouldResendClaim({ ...base, state: 'claimed-on-chain' })).toBe(false);
  });

  it('never sends before the reveal', () => {
    expect(shouldResendClaim({ ...base, revealedAt: null })).toBe(false);
  });
});

describe('revealProblems', () => {
  const PKG = '0x' + '1'.repeat(64);
  const recovery = { btcSats: 100_000, suiAmount: '12338000000', suiRecipient: '0x' + 'a'.repeat(64), hash: 'ab'.repeat(32) } as RecoveryFile;
  const NOW = 1_700_000_000_000;
  const htlc = (over: Partial<HtlcOnChain> = {}): HtlcOnChain => ({
    id: '0xh', type: `${PKG}::htlc::Htlc<0x2::sui::SUI>`, amountMist: 12_338_000_000n, sender: '0x' + 'b'.repeat(64),
    recipient: recovery.suiRecipient, hash: recovery.hash, refundAfterMs: NOW + 3_600_000, ...over,
  });
  const utxo = (value: number, txid = 'aa'): Utxo => ({ txid, vout: 0, value, confirmed: false, blockHeight: null });
  const check = (over: Partial<Parameters<typeof revealProblems>[0]> = {}) =>
    revealProblems({ htlc: htlc(), utxos: [utxo(100_000)], botDepositSats: 100_000, recovery, packageId: PKG, nowMs: NOW, ...over });

  it('passes an HTLC that matches the swap and the deposit', () => {
    expect(check()).toEqual([]);
  });

  it('fails closed when the paid amount is unknown', () => {
    expect(check({ utxos: [], botDepositSats: 100_000 })).toEqual(['deposit amount could not be verified']);
    expect(check({ utxos: null, botDepositSats: null })).toEqual(['deposit amount could not be verified']);
  });

  it('reports a short lock for a single payment with the amounts', () => {
    expect(check({ htlc: htlc({ amountMist: 1n }) })).toEqual(['locked amount 1 MIST is below the expected 12338000000 MIST']);
  });

  it('explains a short lock after a payment made in several parts', () => {
    const utxos = [utxo(60_000, 'aa'), utxo(40_000, 'bb')];
    expect(check({ utxos, htlc: htlc({ amountMist: 7_402_800_000n }) })).toEqual([SPLIT_DEPOSIT_PROBLEM]);
    expect(SPLIT_DEPOSIT_PROBLEM).toBe('you paid in several parts; the bot locked SUI for the first payment only — refund after the locktime');
    // Locked for the full total: nothing to explain.
    expect(check({ utxos })).toEqual([]);
  });

  it('still reports the other mismatches next to the split-payment message', () => {
    const utxos = [utxo(60_000, 'aa'), utxo(40_000, 'bb')];
    expect(check({ utxos, htlc: htlc({ amountMist: 1n, hash: '00'.repeat(32) }) })).toEqual([
      'HTLC hash does not match your secret',
      SPLIT_DEPOSIT_PROBLEM,
    ]);
  });

  it('refuses an HTLC too close to its deadline', () => {
    expect(check({ htlc: htlc({ refundAfterMs: NOW + 60_000 }) })).toEqual(['less than 10 minutes left before the Sui deadline']);
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
