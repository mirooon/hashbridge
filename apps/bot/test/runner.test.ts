import type { CreateSwapResponse } from '@hashbridge/core/types';
import { describe, expect, it } from 'vitest';
import { createApi } from '../src/api';
import { tick } from '../src/engine/runner';
import { HASH, PREIMAGE, T0, USER_SUI, makeEnv, type TestEnv } from './fakes';

const REFUND_PUB = '03' + '33'.repeat(32);

async function createSwap(env: TestEnv, hash = HASH) {
  const app = createApi(env.deps);
  const res = await app.request('/swaps', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hash, refundPubkey: REFUND_PUB, suiRecipient: USER_SUI, btcSats: 100_000 }),
  });
  return { app, swap: (await res.json()) as CreateSwapResponse };
}

function pay(env: TestEnv, address: string, txid = 'aa'.repeat(32)) {
  env.btc.utxos.set(address, [{ txid, vout: 0, value: 100_000, confirmed: false, blockHeight: null }]);
}

describe('tick', () => {
  it('runs a full swap: deposit, lock, relayed claim, BTC claim', async () => {
    const env = makeEnv();
    const { app, swap } = await createSwap(env);
    pay(env, swap.htlcAddress);

    await tick(env.deps);
    expect(env.repo.get(swap.swapId)!.status).toBe('SUI_LOCKED');

    const claim = await app.request(`/swaps/${swap.swapId}/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ preimage: PREIMAGE }),
    });
    expect(claim.status).toBe(200);

    await tick(env.deps);
    expect(env.repo.get(swap.swapId)!.status).toBe('BTC_CLAIMED');
    expect(env.btc.broadcasted).toHaveLength(1);
    expect(env.repo.listActive()).toHaveLength(0);
  });

  it('picks up a claim the user sent directly to Sui', async () => {
    const env = makeEnv();
    const { swap } = await createSwap(env);
    pay(env, swap.htlcAddress);
    await tick(env.deps);
    const htlcId = env.repo.get(swap.swapId)!.htlcObjectId!;
    env.sui.claims.set(htlcId, { digest: 'user-claim', preimage: PREIMAGE });
    await tick(env.deps);
    expect(env.repo.get(swap.swapId)).toMatchObject({ status: 'BTC_CLAIMED', claimDigest: 'user-claim' });
  });

  it('refunds SUI when the user never claims', async () => {
    const env = makeEnv();
    const { swap } = await createSwap(env);
    pay(env, swap.htlcAddress);
    await tick(env.deps);
    env.setNow(T0 + 10_000 + 3_600_000);
    await tick(env.deps);
    expect(env.repo.get(swap.swapId)!.status).toBe('SUI_REFUNDED');
  });

  it('keeps processing other swaps when one fails', async () => {
    const env = makeEnv();
    const { swap: a } = await createSwap(env);
    const { swap: b } = await createSwap(env, '11'.repeat(32));
    env.btc.failAddresses.add(a.htlcAddress);
    pay(env, b.htlcAddress, 'bb'.repeat(32));
    await tick(env.deps);
    expect(env.repo.get(a.swapId)!.status).toBe('AWAITING_DEPOSIT');
    expect(env.repo.get(b.swapId)!.status).toBe('SUI_LOCKED');
    expect(env.logs).toContain('swap step failed');
  });
});
