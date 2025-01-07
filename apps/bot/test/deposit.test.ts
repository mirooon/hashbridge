import type { Utxo } from '@hashbridge/core/types';
import { describe, expect, it } from 'vitest';
import { confirmations, pickDeposit, stepAwaitingDeposit } from '../src/engine/deposit';
import { FIXTURE_HTLC_ADDRESS, T0, makeEnv, makeSwap } from './fakes';

const utxo = (over: Partial<Utxo> = {}): Utxo => ({
  txid: 'aa'.repeat(32), vout: 0, value: 100_000, confirmed: false, blockHeight: null, ...over,
});

describe('stepAwaitingDeposit', () => {
  it('does nothing while the HTLC address is empty', async () => {
    const env = makeEnv();
    env.repo.insert(makeSwap());
    await stepAwaitingDeposit(env.repo.get('swap-1')!, env.deps);
    expect(env.repo.get('swap-1')).toMatchObject({ status: 'AWAITING_DEPOSIT', depositFirstSeenAt: null });
  });

  it('accepts a mempool deposit when MIN_CONF is 0', async () => {
    const env = makeEnv();
    env.repo.insert(makeSwap());
    env.btc.utxos.set(FIXTURE_HTLC_ADDRESS, [utxo({ vout: 1, value: 120_000 })]);
    await stepAwaitingDeposit(env.repo.get('swap-1')!, env.deps);
    expect(env.repo.get('swap-1')).toMatchObject({
      status: 'DEPOSIT_SEEN', depositTxid: 'aa'.repeat(32), depositVout: 1, depositSats: 120_000, depositFirstSeenAt: T0 + 10_000,
    });
  });

  it('records first sight but waits for confirmations when MIN_CONF is 1', async () => {
    const env = makeEnv({ minConf: 1 });
    env.repo.insert(makeSwap());
    env.btc.utxos.set(FIXTURE_HTLC_ADDRESS, [utxo()]);
    await stepAwaitingDeposit(env.repo.get('swap-1')!, env.deps);
    expect(env.repo.get('swap-1')).toMatchObject({ status: 'AWAITING_DEPOSIT', depositFirstSeenAt: T0 + 10_000 });

    env.setNow(T0 + 900_000);
    env.btc.utxos.set(FIXTURE_HTLC_ADDRESS, [utxo({ confirmed: true, blockHeight: env.btc.tip })]);
    await stepAwaitingDeposit(env.repo.get('swap-1')!, env.deps);
    expect(env.repo.get('swap-1')).toMatchObject({ status: 'DEPOSIT_SEEN', depositFirstSeenAt: T0 + 10_000 });
  });

  it('expires a swap whose locktime passed without a deposit', async () => {
    const env = makeEnv();
    env.repo.insert(makeSwap());
    env.btc.tip = 241_872;
    await stepAwaitingDeposit(env.repo.get('swap-1')!, env.deps);
    expect(env.repo.get('swap-1')!.status).toBe('EXPIRED');
  });
});

describe('pickDeposit', () => {
  it('prefers the earliest confirmed output, then txid order', () => {
    const a = utxo({ txid: 'bb'.repeat(32) });
    const b = utxo({ txid: 'cc'.repeat(32), confirmed: true, blockHeight: 10 });
    const c = utxo({ txid: 'dd'.repeat(32), confirmed: true, blockHeight: 9 });
    const d = utxo({ txid: 'aa'.repeat(32) });
    expect(pickDeposit([a, b, c, d])?.txid).toBe('dd'.repeat(32));
    expect(pickDeposit([a, d])?.txid).toBe('aa'.repeat(32));
    expect(pickDeposit([])).toBeUndefined();
  });
});

describe('confirmations', () => {
  it('counts the including block', () => {
    expect(confirmations(utxo({ confirmed: true, blockHeight: 100 }), 100)).toBe(1);
    expect(confirmations(utxo({ confirmed: true, blockHeight: 98 }), 100)).toBe(3);
    expect(confirmations(utxo(), 100)).toBe(0);
  });
});
