import { buildWitnessScript, htlcAddress } from '@hashbridge/core/htlc-script';
import { bytesToHex, hexToBytes } from '@hashbridge/core/secret';
import type { CreateSwapResponse } from '@hashbridge/core/types';
import { describe, expect, it } from 'vitest';
import { createApi } from '../src/api';
import { BOT_KEY, HASH, PREIMAGE, T0, USER_SUI, makeEnv, makeSwap } from './fakes';

const REFUND_PUB = '03' + '33'.repeat(32);
const body = (over: Record<string, unknown> = {}) => ({ hash: HASH, refundPubkey: REFUND_PUB, suiRecipient: USER_SUI, btcSats: 100_000, ...over });
const post = (app: ReturnType<typeof createApi>, path: string, data: unknown) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });

describe('POST /swaps', () => {
  it('creates a swap whose script the user can recompute', async () => {
    const env = makeEnv();
    const res = await post(createApi(env.deps), '/swaps', body());
    expect(res.status).toBe(201);
    const json = (await res.json()) as CreateSwapResponse;
    const expected = bytesToHex(
      buildWitnessScript({ hash: hexToBytes(HASH), claimPubkey: BOT_KEY.publicKey, refundPubkey: hexToBytes(REFUND_PUB), locktime: 241_872 }),
    );
    expect(json).toMatchObject({
      locktime: 241_872, witnessScript: expected, htlcAddress: htlcAddress(hexToBytes(expected)), suiAmount: '12338000000',
      quoteExpiresAt: T0 + 10_000 + 60_000, botPubkey: bytesToHex(BOT_KEY.publicKey),
    });
    expect(env.repo.get(json.swapId)).toMatchObject({ status: 'AWAITING_DEPOSIT', refundPubkey: REFUND_PUB, hash: HASH });
  });

  it('rejects malformed input', async () => {
    const app = createApi(makeEnv().deps);
    for (const bad of [
      body({ hash: 'zz' }),
      body({ refundPubkey: '04' + '33'.repeat(32) }),
      body({ suiRecipient: 'a'.repeat(64) }),
      body({ btcSats: 1.5 }),
      body({ btcSats: 5_000_000 }),
      'not json',
    ]) {
      expect((await post(app, '/swaps', bad)).status).toBe(400);
    }
  });

  it('normalizes an uppercase Sui address', async () => {
    const env = makeEnv();
    const res = await post(createApi(env.deps), '/swaps', body({ suiRecipient: '0x' + 'A'.repeat(64) }));
    const json = (await res.json()) as CreateSwapResponse;
    expect(env.repo.get(json.swapId)!.suiRecipient).toBe(USER_SUI);
  });

  it('rejects a reused hash', async () => {
    const app = createApi(makeEnv().deps);
    await post(app, '/swaps', body());
    expect((await post(app, '/swaps', body())).status).toBe(409);
  });

  it('gives 409, not 500, when two concurrent requests reuse one hash', async () => {
    const env = makeEnv();
    const app = createApi(env.deps);
    const statuses = (await Promise.all([post(app, '/swaps', body()), post(app, '/swaps', body())])).map((r) => r.status);
    expect(statuses.sort()).toEqual([201, 409]);
    expect(env.repo.all()).toHaveLength(1);
  });

  it('refuses quotes it cannot cover', async () => {
    const env = makeEnv();
    env.sui.balance = 0n;
    expect((await post(createApi(env.deps), '/swaps', body())).status).toBe(503);
  });
});

describe('GET /swaps/:id', () => {
  it('returns 404 for unknown swaps', async () => {
    expect((await createApi(makeEnv().deps).request('/swaps/nope')).status).toBe(404);
  });

  it('hides private fields', async () => {
    const env = makeEnv();
    env.repo.insert(makeSwap({ preimage: PREIMAGE, btcClaimTxHex: 'ab', pendingTx: { kind: 'lock', digest: 'd', bytes: 'AA==', signature: 'c2ln' } }));
    const json = (await (await createApi(env.deps).request('/swaps/swap-1')).json()) as Record<string, unknown>;
    expect(json.status).toBe('AWAITING_DEPOSIT');
    for (const key of ['preimage', 'btcClaimTxHex', 'pendingTx', 'refundPubkey', 'depositFirstSeenAt']) expect(json).not.toHaveProperty(key);
  });
});

describe('POST /swaps/:id/claim', () => {
  const locked = () => makeSwap({ status: 'SUI_LOCKED', htlcObjectId: 'htlc-1', suiDeadlineMs: T0 + 3_600_000, depositTxid: 'aa'.repeat(32), depositVout: 0, depositSats: 100_000 });

  it('relays a valid preimage and marks the swap claimed', async () => {
    const env = makeEnv();
    env.repo.insert(locked());
    const res = await post(createApi(env.deps), '/swaps/swap-1/claim', { preimage: PREIMAGE });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ digest: 'digest-1' });
    expect(env.sui.lastClaim).toEqual({ htlcObjectId: 'htlc-1', preimage: PREIMAGE });
    expect(env.repo.get('swap-1')).toMatchObject({ status: 'SUI_CLAIMED', preimage: PREIMAGE, claimDigest: 'digest-1' });
  });

  it('rejects a wrong preimage', async () => {
    const env = makeEnv();
    env.repo.insert(locked());
    expect((await post(createApi(env.deps), '/swaps/swap-1/claim', { preimage: '08'.repeat(32) })).status).toBe(400);
  });

  it('refuses to claim before SUI is locked', async () => {
    const env = makeEnv();
    env.repo.insert(makeSwap());
    expect((await post(createApi(env.deps), '/swaps/swap-1/claim', { preimage: PREIMAGE })).status).toBe(409);
  });

  it('refuses to claim within a minute of the Sui deadline', async () => {
    const env = makeEnv();
    env.repo.insert(locked());
    env.setNow(T0 + 3_600_000 - 59_000);
    expect((await post(createApi(env.deps), '/swaps/swap-1/claim', { preimage: PREIMAGE })).status).toBe(409);
  });

  it('is idempotent once claimed', async () => {
    const env = makeEnv();
    env.repo.insert(locked());
    const app = createApi(env.deps);
    await post(app, '/swaps/swap-1/claim', { preimage: PREIMAGE });
    const again = await post(app, '/swaps/swap-1/claim', { preimage: PREIMAGE });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ digest: 'digest-1' });
    expect(env.sui.signed).toHaveLength(1);
  });

  it('returns the digest of a racing claim that already landed instead of 502', async () => {
    const env = makeEnv();
    env.repo.insert(locked());
    const realExecute = env.sui.execute.bind(env.sui);
    env.sui.execute = async (tx) => {
      // Another request claimed the swap while this one was in flight; this tx then fails on chain.
      env.repo.update('swap-1', { status: 'SUI_CLAIMED', claimDigest: 'earlier' });
      env.sui.nextFails = true;
      return realExecute(tx);
    };
    const res = await post(createApi(env.deps), '/swaps/swap-1/claim', { preimage: PREIMAGE });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ digest: 'earlier' });
  });
});

describe('GET /health', () => {
  it('reports balances and quote parameters', async () => {
    const env = makeEnv();
    const json = await (await createApi(env.deps).request('/health')).json();
    expect(json).toMatchObject({
      botPubkey: bytesToHex(BOT_KEY.publicKey), suiAddress: '0x' + 'b'.repeat(64), btcSats: 0, suiMist: '1000000000000',
      tipHeight: 241_800, rate: 12_400, spreadBps: 50, minBtcSats: 10_000, maxBtcSats: 1_000_000,
    });
  });
});
