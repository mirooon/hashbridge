import type { BtcChain, Utxo } from './types';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const FALLBACK_FEE_RATE = 2;

interface EsploraUtxo {
  txid: string;
  vout: number;
  value: number;
  status: { confirmed: boolean; block_height?: number };
}

export class EsploraClient implements BtcChain {
  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;

  constructor(baseUrl: string, fetchFn?: FetchLike) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    // Wrapped so the browser's fetch is never called with a foreign `this`.
    this.fetchFn = fetchFn ?? ((input, init) => fetch(input, init));
  }

  private async get(path: string): Promise<Response> {
    const res = await this.fetchFn(this.baseUrl + path);
    if (!res.ok) throw new Error(`Esplora GET ${path} failed: ${res.status} ${await res.text()}`);
    return res;
  }

  async tipHeight(): Promise<number> {
    const text = (await (await this.get('/blocks/tip/height')).text()).trim();
    const height = Number(text);
    if (!Number.isInteger(height)) throw new Error(`unexpected tip height: ${text}`);
    return height;
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
    const res = await this.fetchFn(`${this.baseUrl}/tx`, {
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
