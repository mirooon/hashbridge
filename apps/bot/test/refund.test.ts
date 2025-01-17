import { describe, expect, it } from 'vitest';
import { stepRefundSui } from '../src/engine/refund';
import { T0, makeEnv, makeSwap } from './fakes';

const locked = () => makeSwap({ status: 'SUI_LOCKED', htlcObjectId: 'htlc-1', suiDeadlineMs: T0 + 3_600_000, lockDigest: 'digest-0' });

describe('stepRefundSui', () => {
  it('waits until the Sui deadline', async () => {
    const env = makeEnv();
    env.repo.insert(locked());
    env.setNow(T0 + 3_599_999);
    await stepRefundSui(env.repo.get('swap-1')!, env.deps);
    expect(env.sui.signed).toHaveLength(0);
    expect(env.repo.get('swap-1')!.status).toBe('SUI_LOCKED');
  });

  it('refunds after the deadline', async () => {
    const env = makeEnv();
    env.repo.insert(locked());
    env.setNow(T0 + 3_600_000);
    await stepRefundSui(env.repo.get('swap-1')!, env.deps);
    expect(env.sui.lastRefund).toBe('htlc-1');
    expect(env.repo.get('swap-1')).toMatchObject({ status: 'SUI_REFUNDED', refundDigest: 'digest-1' });
  });

  it('stays SUI_LOCKED when the refund tx fails', async () => {
    const env = makeEnv();
    env.repo.insert(locked());
    env.setNow(T0 + 3_600_000);
    env.sui.nextFails = true;
    await expect(stepRefundSui(env.repo.get('swap-1')!, env.deps)).rejects.toThrow(/refund tx digest-1 failed/);
    expect(env.repo.get('swap-1')!.status).toBe('SUI_LOCKED');
  });
});
