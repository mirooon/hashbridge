import type { BtcChain, Utxo } from './types';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const FALLBACK_FEE_RATE = 2;
/** Deadline of every Esplora request, so a stalled connection cannot hang the caller (the bot's loop, the refund button). */
export const ESPLORA_TIMEOUT_MS = 15_000;

interface EsploraUtxo {
  txid: string;
  vout: number;
  value: number;
  status: { confirmed: boolean; block_height?: number };
}

export class EsploraClient implements BtcChain {
  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, fetchFn?: FetchLike, timeoutMs = ESPLORA_TIMEOUT_MS) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    // Wrapped so the browser's fetch is never called with a foreign `this`.
    this.fetchFn = fetchFn ?? ((input, init) => fetch(input, init));
    this.timeoutMs = timeoutMs;
  }

  private request(url: string, init: RequestInit = {}): Promise<Response> {
    return this.fetchFn(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) });
  }

  private async get(path: string): Promise<Response> {
    const res = await this.request(this.baseUrl + path);
    if (!res.ok) throw new Error(`Esplora GET ${path} failed: ${res.status} ${await res.text()}`);
    return res;
  }

  async tipHeight(): Promise<number> {
    const text = (await (await this.get('/blocks/tip/height')).text()).trim();
    // Number() would also accept '', '0x10' or '1e3'.
    if (!/^\d+$/.test(text)) throw new Error(`unexpected tip height: ${text}`);
    return Number(text);
  }

  async addressUtxos(address: string): Promise<Utxo[]> {
    const raw = (await (await this.get(`/address/${address}/utxo`)).json()) as EsploraUtxo[];
    return raw.map((u) => ({
      txid: u.txid,
      vout: u.vout,
      value: u.value,
      confirmed: u.status.confirmed,
      blockHeight: u.status.block_height ?? null,
    }));
  }

  async broadcast(txHex: string): Promise<string> {
    const res = await this.request(`${this.baseUrl}/tx`, {
      method: 'POST',
      body: txHex,
      headers: { 'content-type': 'text/plain' },
    });
    const text = (await res.text()).trim();
    if (!res.ok) throw new Error(`broadcast failed: ${res.status} ${text}`);
    return text;
  }

  async feeRate(): Promise<number> {
    try {
      const estimates = (await (await this.get('/fee-estimates')).json()) as Record<string, number>;
      const rate = estimates['2'] ?? estimates['3'] ?? estimates['6'];
      if (typeof rate !== 'number' || !Number.isFinite(rate)) return FALLBACK_FEE_RATE;
      return Math.max(1, Math.ceil(rate));
    } catch {
      return FALLBACK_FEE_RATE;
    }
  }
}
