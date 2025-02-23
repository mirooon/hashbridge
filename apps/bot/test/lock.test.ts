import { describe, expect, it } from 'vitest';
import { stepDepositSeen } from '../src/engine/lock';
import type { SwapRecord } from '../src/types';
import { HASH, T0, USER_SUI, makeEnv, makeSwap } from './fakes';

const seen = (over: Partial<SwapRecord> = {}) =>
  makeSwap({ status: 'DEPOSIT_SEEN', depositTxid: 'aa'.repeat(32), depositVout: 0, depositSats: 100_000, depositFirstSeenAt: T0 + 5_000, ...over });

describe('stepDepositSeen', () => {
  it('locks SUI for the quoted amount until now + SUI_TIMEOUT_MS', async () => {
    const env = makeEnv();
    env.repo.insert(seen());
    await stepDepositSeen(env.repo.get('swap-1')!, env.deps);
    expect(env.repo.get('swap-1')).toMatchObject({
      status: 'SUI_LOCKED', htlcObjectId: 'htlc-of-digest-1', lockDigest: 'digest-1', suiAmount: '12338000000',
      suiDeadlineMs: T0 + 10_000 + 3_600_000, pendingTx: null,
    });
    expect(env.sui.lastLock).toEqual({ recipient: USER_SUI, hash: HASH, amountMist: 12_338_000_000n, deadlineMs: T0 + 10_000 + 3_600_000 });
  });

  it('rejects a deposit made after the quote expired', async () => {
    const env = makeEnv();
    env.repo.insert(seen({ depositFirstSeenAt: T0 + 61_000 }));
    await stepDepositSeen(env.repo.get('swap-1')!, env.deps);
    expect(env.repo.get('swap-1')).toMatchObject({ status: 'REJECTED', rejectReason: 'quote expired before the deposit arrived' });
    expect(env.sui.signed).toHaveLength(0);
  });

  it('rejects a deposit below the minimum', async () => {
    const env = makeEnv();
    env.repo.insert(seen({ depositSats: 5_000 }));
    await stepDepositSeen(env.repo.get('swap-1')!, env.deps);
    expect(env.repo.get('swap-1')).toMatchObject({ status: 'REJECTED', rejectReason: 'deposit below minimum' });
  });

  it('rejects when the BTC locktime is too close', async () => {
    const env = makeEnv();
    env.btc.tip = 241_860;
    env.repo.insert(seen());
    await stepDepositSeen(env.repo.get('swap-1')!, env.deps);
    expect(env.repo.get('swap-1')).toMatchObject({ status: 'REJECTED', rejectReason: 'too close to the BTC locktime' });
  });

  it('rejects when the bot lacks SUI', async () => {
    const env = makeEnv();
    env.sui.balance = 1_000_000_000n;
    env.repo.insert(seen());
    await stepDepositSeen(env.repo.get('swap-1')!, env.deps);
    expect(env.repo.get('swap-1')).toMatchObject({ status: 'REJECTED', rejectReason: 'insufficient SUI liquidity' });
  });

  it('caps the amount at MAX_BTC_SATS', async () => {
    const env = makeEnv();
    env.repo.insert(seen({ depositSats: 5_000_000 }));
    await stepDepositSeen(env.repo.get('swap-1')!, env.deps);
    expect(env.sui.lastLock?.amountMist).toBe(123_380_000_000n);
  });

  it('prices the lock from the stored quote, not the current RATE', async () => {
    const env = makeEnv({ rate: 20_000 });
    env.repo.insert(seen());
    await stepDepositSeen(env.repo.get('swap-1')!, env.deps);
    expect(env.sui.lastLock?.amountMist).toBe(12_338_000_000n);
    expect(env.repo.get('swap-1')!.suiAmount).toBe('12338000000');
  });

  it('scales the quote to a partial deposit', async () => {
    const env = makeEnv();
    env.repo.insert(seen({ depositSats: 50_000 }));
    await stepDepositSeen(env.repo.get('swap-1')!, env.deps);
    expect(env.sui.lastLock?.amountMist).toBe(6_169_000_000n);
  });

  it('keeps the priced amount when a failed lock is retried', async () => {
    const env = makeEnv();
    env.sui.nextFails = true;
    env.repo.insert(seen({ depositSats: 50_000 }));
    await expect(stepDepositSeen(env.repo.get('swap-1')!, env.deps)).rejects.toThrow(/failed/);
    await stepDepositSeen(env.repo.get('swap-1')!, env.deps);
    expect(env.sui.locks.map((l) => l.amountMist)).toEqual([6_169_000_000n, 6_169_000_000n]);
    expect(env.repo.get('swap-1')).toMatchObject({ status: 'SUI_LOCKED', suiAmount: '6169000000' });
  });

  it('records a lock that landed without a Locked event and stops', async () => {
    const env = makeEnv();
    env.sui.noLockedEvent = true;
    env.repo.insert(seen());
    await expect(stepDepositSeen(env.repo.get('swap-1')!, env.deps)).rejects.toThrow(/no Locked event/);
    expect(env.repo.get('swap-1')).toMatchObject({ status: 'DEPOSIT_SEEN', lockDigest: 'digest-1', htlcObjectId: null, pendingTx: null });
    expect(env.logs).toContain('lock landed without Locked event; manual action needed');
  });

  it('never signs another lock while a landed lock lacks its Locked event', async () => {
    const env = makeEnv();
    env.repo.insert(seen({ lockDigest: 'digest-9', suiAmount: '12338000000', suiDeadlineMs: T0 + 3_600_000 }));
    await stepDepositSeen(env.repo.get('swap-1')!, env.deps);
    await stepDepositSeen(env.repo.get('swap-1')!, env.deps);
    expect(env.sui.signed).toHaveLength(0);
    expect(env.repo.get('swap-1')).toMatchObject({ status: 'DEPOSIT_SEEN', lockDigest: 'digest-9' });
    expect(env.logs.filter((l) => l === 'lock landed without Locked event; manual action needed')).toHaveLength(2);
  });

  it('resumes a lock that landed before a crash without signing again', async () => {
    const env = makeEnv();
    env.repo.insert(
      seen({ suiAmount: '12338000000', suiDeadlineMs: T0 + 3_600_000, pendingTx: { kind: 'lock', digest: 'digest-77', bytes: 'AA==', signature: 'c2ln' } }),
    );
    env.sui.executed.set('digest-77', { digest: 'digest-77', success: true, error: null, htlcObjectId: 'htlc-77' });
    await stepDepositSeen(env.repo.get('swap-1')!, env.deps);
    expect(env.repo.get('swap-1')).toMatchObject({ status: 'SUI_LOCKED', htlcObjectId: 'htlc-77', lockDigest: 'digest-77' });
    expect(env.sui.signed).toHaveLength(0);
  });

  it('stays in DEPOSIT_SEEN when the lock tx fails', async () => {
    const env = makeEnv();
    env.sui.nextFails = true;
    env.repo.insert(seen());
    await expect(stepDepositSeen(env.repo.get('swap-1')!, env.deps)).rejects.toThrow(/lock tx digest-1 failed/);
    expect(env.repo.get('swap-1')).toMatchObject({ status: 'DEPOSIT_SEEN', pendingTx: null });
  });
});
