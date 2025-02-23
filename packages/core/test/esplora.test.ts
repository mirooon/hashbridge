import { describe, expect, it } from 'vitest';
import { ESPLORA_TIMEOUT_MS, EsploraClient, FALLBACK_FEE_RATE } from '../src/esplora';

const BASE = 'https://esplora.test/api';

function fakeFetch(routes: Record<string, { status?: number; body: string }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const route = routes[`${init?.method ?? 'GET'} ${url}`];
    if (!route) return new Response('not found', { status: 404 });
    return new Response(route.body, { status: route.status ?? 200 });
  };
  return { fn, calls };
}

describe('EsploraClient', () => {
  it('reads the tip height', async () => {
    const { fn } = fakeFetch({ [`GET ${BASE}/blocks/tip/height`]: { body: '241872\n' } });
    expect(await new EsploraClient(BASE, fn).tipHeight()).toBe(241_872);
  });

  it('maps address UTXOs', async () => {
    const body = JSON.stringify([
      { txid: 'aa'.repeat(32), vout: 1, value: 5_000, status: { confirmed: true, block_height: 100, block_hash: 'x', block_time: 1 } },
      { txid: 'bb'.repeat(32), vout: 0, value: 7_000, status: { confirmed: false } },
    ]);
    const { fn } = fakeFetch({ [`GET ${BASE}/address/tb1qxyz/utxo`]: { body } });
    expect(await new EsploraClient(BASE, fn).addressUtxos('tb1qxyz')).toEqual([
      { txid: 'aa'.repeat(32), vout: 1, value: 5_000, confirmed: true, blockHeight: 100 },
      { txid: 'bb'.repeat(32), vout: 0, value: 7_000, confirmed: false, blockHeight: null },
    ]);
  });

  it('broadcasts raw hex and returns the txid', async () => {
    const { fn, calls } = fakeFetch({ [`POST ${BASE}/tx`]: { body: 'cc'.repeat(32) } });
    expect(await new EsploraClient(BASE, fn).broadcast('0200beef')).toBe('cc'.repeat(32));
    expect(calls[0]!.init?.body).toBe('0200beef');
  });

  it('surfaces the node message when a broadcast fails', async () => {
    const { fn } = fakeFetch({
      [`POST ${BASE}/tx`]: { status: 400, body: 'sendrawtransaction RPC error: {"code":-26,"message":"min relay fee not met"}' },
    });
    await expect(new EsploraClient(BASE, fn).broadcast('00')).rejects.toThrow(/min relay fee not met/);
  });

  it('uses the 2-block fee estimate rounded up', async () => {
    const { fn } = fakeFetch({ [`GET ${BASE}/fee-estimates`]: { body: '{"1":5.2,"2":3.01,"6":1.5}' } });
    expect(await new EsploraClient(BASE, fn).feeRate()).toBe(4);
  });

  it('falls back when fee estimates are unavailable', async () => {
    const { fn } = fakeFetch({ [`GET ${BASE}/fee-estimates`]: { status: 500, body: 'oops' } });
    expect(await new EsploraClient(BASE, fn).feeRate()).toBe(FALLBACK_FEE_RATE);
  });

  it('throws on HTTP errors for reads', async () => {
    const { fn } = fakeFetch({});
    await expect(new EsploraClient(BASE, fn).tipHeight()).rejects.toThrow(/404/);
  });

  it('rejects tip heights that are not plain decimal digits', async () => {
    for (const body of ['', '0x10', '1e3', '12.5', '-1', ' ']) {
      const { fn } = fakeFetch({ [`GET ${BASE}/blocks/tip/height`]: { body } });
      await expect(new EsploraClient(BASE, fn).tipHeight()).rejects.toThrow(/unexpected tip height/);
    }
  });

  it('gives every request a timeout signal', async () => {
    const { fn, calls } = fakeFetch({
      [`GET ${BASE}/blocks/tip/height`]: { body: '1' },
      [`GET ${BASE}/address/tb1qxyz/utxo`]: { body: '[]' },
      [`POST ${BASE}/tx`]: { body: 'cc'.repeat(32) },
      [`GET ${BASE}/fee-estimates`]: { body: '{"2":1}' },
    });
    const client = new EsploraClient(BASE, fn);
    await client.tipHeight();
    await client.addressUtxos('tb1qxyz');
    await client.broadcast('00');
    await client.feeRate();
    expect(calls).toHaveLength(4);
    for (const call of calls) expect(call.init?.signal).toBeInstanceOf(AbortSignal);
    expect(ESPLORA_TIMEOUT_MS).toBe(15_000);
  });

  it('aborts a request that stalls past the timeout', async () => {
    const stalled = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      });
    await expect(new EsploraClient(BASE, stalled, 20).tipHeight()).rejects.toThrow(/timeout|aborted/i);
    await expect(new EsploraClient(BASE, stalled, 20).broadcast('00')).rejects.toThrow(/timeout|aborted/i);
  });

  it('strips a trailing slash from the base URL', async () => {
    const { fn, calls } = fakeFetch({ [`GET ${BASE}/blocks/tip/height`]: { body: '1' } });
    await new EsploraClient(`${BASE}/`, fn).tipHeight();
    expect(calls[0]!.url).toBe(`${BASE}/blocks/tip/height`);
  });
});
