import type { ClaimResponse, CreateSwapRequest, CreateSwapResponse, HealthResponse, SwapView } from '@hashbridge/core/types';

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HashbridgeApi {
  health(): Promise<HealthResponse>;
  createSwap(req: CreateSwapRequest): Promise<CreateSwapResponse>;
  getSwap(swapId: string): Promise<SwapView>;
  claim(swapId: string, preimage: string): Promise<ClaimResponse>;
}

export function createApi(baseUrl: string, fetchFn: FetchLike = (input, init) => fetch(input, init)): HashbridgeApi {
  const base = baseUrl.replace(/\/$/, '');

  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    // Only requests with a body get the JSON header, so GET polling stays a simple CORS request.
    const headers: Record<string, string> = init?.body !== undefined ? { 'content-type': 'application/json' } : {};
    let res: Response;
    let text: string;
    try {
      res = await fetchFn(base + path, { ...init, headers });
      text = await res.text();
    } catch (err) {
      throw new ApiError(0, `Bot unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }
    let body: unknown = null;
    let valid = false;
    if (text) {
      try {
        body = JSON.parse(text);
        valid = true;
      } catch {
        body = null;
      }
    }
    if (!res.ok) {
      const error = (body as { error?: unknown } | null)?.error;
      throw new ApiError(res.status, typeof error === 'string' ? error : `HTTP ${res.status}`);
    }
    if (!valid) throw new ApiError(res.status, 'Bot returned an invalid response');
    return body as T;
  }

  return {
    health: () => call('/health'),
    createSwap: (req) => call('/swaps', { method: 'POST', body: JSON.stringify(req) }),
    getSwap: (swapId) => call(`/swaps/${encodeURIComponent(swapId)}`),
    claim: (swapId, preimage) =>
      call(`/swaps/${encodeURIComponent(swapId)}/claim`, { method: 'POST', body: JSON.stringify({ preimage }) }),
  };
}
