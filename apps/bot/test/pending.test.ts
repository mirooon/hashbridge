import { describe, expect, it } from 'vitest';
import { submitOnce } from '../src/engine/pending';
import type { SignedTx } from '../src/types';
import { HASH, USER_SUI, makeEnv, makeSwap } from './fakes';

const lockParams = { recipient: USER_SUI, hash: HASH, amountMist: 1n, deadlineMs: 1 };
const PENDING: SignedTx = { kind: 'lock', digest: 'digest-99', bytes: 'AA==', signature: 'c2ln' };

describe('submitOnce', () => {
  it('persists the signed tx before executing it, then clears it', async () => {
    const env = makeEnv();
    env.repo.insert(makeSwap());
    const seen: { pending: SignedTx | null } = { pending: null };
    const original = env.sui.execute.bind(env.sui);
    env.sui.execute = async (tx) => {
      seen.pending = env.repo.get('swap-1')!.pendingTx;
      return original(tx);
    };
    const res = await submitOnce(env.repo.get('swap-1')!, env.deps, 'lock', () => env.sui.signLock(lockParams));
    expect(res.success).toBe(true);
    expect(seen.pending?.digest).toBe(res.digest);
    expect(env.repo.get('swap-1')!.pendingTx).toBeNull();
  });

  it('does not re-send a pending tx that already landed', async () => {
    const env = makeEnv();
    env.repo.insert(makeSwap({ pendingTx: PENDING }));
    env.sui.executed.set('digest-99', { digest: 'digest-99', success: true, error: null, htlcObjectId: 'h' });
    const res = await submitOnce(env.repo.get('swap-1')!, env.deps, 'lock', () => env.sui.signLock(lockParams));
    expect(res.htlcObjectId).toBe('h');
    expect(env.sui.signed).toHaveLength(0);
    expect(env.repo.get('swap-1')!.pendingTx).toBeNull();
  });

  it('re-sends the same signed bytes when the pending tx is unknown on chain', async () => {
    const env = makeEnv();
    env.repo.insert(makeSwap({ pendingTx: PENDING }));
    const res = await submitOnce(env.repo.get('swap-1')!, env.deps, 'lock', () => env.sui.signLock(lockParams));
    expect(res.digest).toBe('digest-99');
    expect(env.sui.signed).toHaveLength(0);
    expect(env.repo.get('swap-1')!.pendingTx).toBeNull();
  });

  it('refuses to start a different kind while another tx is pending', async () => {
    const env = makeEnv();
    env.repo.insert(makeSwap({ pendingTx: PENDING }));
    await expect(submitOnce(env.repo.get('swap-1')!, env.deps, 'refund', () => env.sui.signRefund('h'))).rejects.toThrow(/pending lock/);
  });

  it('drops a pending tx whose inputs were consumed', async () => {
    const env = makeEnv();
    env.repo.insert(makeSwap());
    env.sui.executeError = new Error('Transaction needs to be rebuilt because object 0x5 version 0x9 is unavailable for consumption');
    await expect(submitOnce(env.repo.get('swap-1')!, env.deps, 'lock', () => env.sui.signLock(lockParams))).rejects.toThrow(/rebuilt/);
    expect(env.repo.get('swap-1')!.pendingTx).toBeNull();
  });

  it('keeps the pending tx on transient errors', async () => {
    const env = makeEnv();
    env.repo.insert(makeSwap());
    env.sui.executeError = new Error('fetch failed');
    await expect(submitOnce(env.repo.get('swap-1')!, env.deps, 'lock', () => env.sui.signLock(lockParams))).rejects.toThrow(/fetch failed/);
    expect(env.repo.get('swap-1')!.pendingTx?.kind).toBe('lock');
  });

  it('keeps the pending tx and rethrows the execute error when the lookup itself fails', async () => {
    const env = makeEnv();
    env.repo.insert(makeSwap());
    env.sui.executeError = new Error('Transaction needs to be rebuilt because object 0x5 version 0x9 is unavailable for consumption');
    env.sui.lookup = async () => {
      throw new Error('rpc down');
    };
    await expect(submitOnce(env.repo.get('swap-1')!, env.deps, 'lock', () => env.sui.signLock(lockParams))).rejects.toThrow(/rebuilt/);
    expect(env.repo.get('swap-1')!.pendingTx?.digest).toBe('digest-1');
  });

  it('returns the landed result when execute throws but the tx is on chain', async () => {
    const env = makeEnv();
    env.repo.insert(makeSwap());
    env.sui.executeError = new Error('fetch failed');
    env.sui.executed.set('digest-1', { digest: 'digest-1', success: true, error: null, htlcObjectId: 'h-landed' });
    const res = await submitOnce(env.repo.get('swap-1')!, env.deps, 'lock', () => env.sui.signLock(lockParams));
    expect(res).toEqual({ digest: 'digest-1', success: true, error: null, htlcObjectId: 'h-landed' });
    expect(env.repo.get('swap-1')!.pendingTx).toBeNull();
  });

  it('serializes concurrent submissions', async () => {
    const env = makeEnv();
    env.repo.insert(makeSwap({ swapId: 'a', hash: '01'.repeat(32) }));
    env.repo.insert(makeSwap({ swapId: 'b', hash: '02'.repeat(32) }));
    env.sui.executeDelayMs = 20;
    const events: string[] = [];
    const original = env.sui.execute.bind(env.sui);
    env.sui.execute = async (tx) => {
      const res = await original(tx);
      events.push(`exec-${tx.digest}`);
      return res;
    };
    const sign = (label: string) => async () => {
      events.push(`sign-${label}`);
      return env.sui.signLock(lockParams);
    };
    await Promise.all([
      submitOnce(env.repo.get('a')!, env.deps, 'lock', sign('a')),
      submitOnce(env.repo.get('b')!, env.deps, 'lock', sign('b')),
    ]);
    expect(events).toEqual(['sign-a', 'exec-digest-1', 'sign-b', 'exec-digest-2']);
  });
});
