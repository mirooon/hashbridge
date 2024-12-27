import { describe, expect, it } from 'vitest';
import { ApiError, createApi } from '../src/lib/api';

function fake(status: number, body: unknown) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(body === undefined ? '' : JSON.stringify(body), { status });
  };
  return { fn, calls };
}

describe('createApi', () => {
  it('posts a swap as JSON', async () => {
    const { fn, calls } = fake(201, { swapId: 's1' });
    const api = createApi('http://bot.test/', fn);
    const req = { hash: 'ab'.repeat(32), refundPubkey: '02' + '11'.repeat(32), suiRecipient: '0x' + 'a'.repeat(64), btcSats: 100_000 };
    expect(await api.createSwap(req)).toEqual({ swapId: 's1' });
    expect(calls[0]!.url).toBe('http://bot.test/swaps');
    expect(calls[0]!.init?.method).toBe('POST');
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual(req);
  });

  it('turns error bodies into ApiError', async () => {
    const { fn } = fake(409, { error: 'hash already used by another swap' });
    const err = await createApi('http://bot.test', fn).getSwap('x').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(409);
    expect(err.message).toBe('hash already used by another swap');
  });

  it('reports an unreachable bot as status 0', async () => {
    const api = createApi('http://bot.test', async () => { throw new TypeError('Failed to fetch'); });
    const err = await api.health().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(0);
  });

  it('encodes ids in paths and posts the preimage', async () => {
    const { fn, calls } = fake(200, { digest: 'D' });
    await createApi('http://bot.test', fn).claim('a/b', 'cd'.repeat(32));
    expect(calls[0]!.url).toBe('http://bot.test/swaps/a%2Fb/claim');
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ preimage: 'cd'.repeat(32) });
  });

  it('rejects a 2xx response whose body is not JSON', async () => {
    const fn = async () => new Response('<html>oops</html>', { status: 200 });
    const err = await createApi('http://bot.test', fn).getSwap('x').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(200);
    expect(err.message).toBe('Bot returned an invalid response');
  });

  it('reports a body that fails to read as status 0', async () => {
    const fn = async () => {
      const res = new Response('', { status: 200 });
      res.text = async () => { throw new TypeError('aborted'); };
      return res;
    };
    const err = await createApi('http://bot.test', fn).health().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(0);
    expect(err.message).toBe('Bot unreachable: aborted');
  });

  it('sends the JSON content-type only on requests with a body', async () => {
    const { fn, calls } = fake(200, { swapId: 's1' });
    const api = createApi('http://bot.test', fn);
    const req = { hash: 'ab'.repeat(32), refundPubkey: '02' + '11'.repeat(32), suiRecipient: '0x' + 'a'.repeat(64), btcSats: 100_000 };
    await api.getSwap('s1');
    await api.createSwap(req);
    expect(new Headers(calls[0]!.init?.headers).has('content-type')).toBe(false);
    expect(new Headers(calls[1]!.init?.headers).get('content-type')).toBe('application/json');
  });
});
