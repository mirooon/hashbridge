import type { RecoveryFile } from '@hashbridge/core/types';

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface LocalSwapState {
  recovery: RecoveryFile;
  recoveryDownloaded: boolean;
  claimSentAt: number | null;
}

export interface SwapStorage {
  save(state: LocalSwapState): void;
  load(swapId: string): LocalSwapState | null;
  update(swapId: string, patch: Partial<Omit<LocalSwapState, 'recovery'>>): LocalSwapState | null;
}

const PREFIX = 'hashbridge:swap:';

export function memoryStore(): KeyValueStore {
  const map = new Map<string, string>();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v); } };
}

function browserStore(): KeyValueStore {
  try {
    const ls = window.localStorage;
    ls.setItem('__hashbridge_probe__', '1');
    ls.removeItem('__hashbridge_probe__');
    return ls;
  } catch {
    return memoryStore();
  }
}

export function createSwapStorage(store: KeyValueStore = browserStore()): SwapStorage {
  const save = (state: LocalSwapState) => {
    try {
      store.setItem(PREFIX + state.recovery.swapId, JSON.stringify(state));
    } catch {
      // Storage full or blocked: the downloaded recovery file is the backup.
    }
  };
  const load = (swapId: string): LocalSwapState | null => {
    try {
      const raw = store.getItem(PREFIX + swapId);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as LocalSwapState;
      return parsed?.recovery?.swapId === swapId ? parsed : null;
    } catch {
      return null;
    }
  };
  return {
    save,
    load,
    update(swapId, patch) {
      const current = load(swapId);
      if (!current) return null;
      const next = { ...current, ...patch };
      save(next);
      return next;
    },
  };
}

const HEX64 = /^[0-9a-f]{64}$/;
const PUBKEY = /^0[23][0-9a-f]{64}$/;

export function parseRecoveryFile(text: string): RecoveryFile {
  const fail = (field: string): never => {
    throw new Error(`Invalid recovery file: ${field}`);
  };
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    fail('not JSON');
  }
  if (!data || typeof data !== 'object') fail('root');
  if (data.version !== 1) fail('version');
  if (typeof data.swapId !== 'string' || data.swapId === '') fail('swapId');
  for (const field of ['secret', 'hash', 'refundPrivkey'] as const) {
    if (typeof data[field] !== 'string' || !HEX64.test(data[field] as string)) fail(field);
  }
  for (const field of ['refundPubkey', 'botPubkey'] as const) {
    if (typeof data[field] !== 'string' || !PUBKEY.test(data[field] as string)) fail(field);
  }
  if (typeof data.witnessScript !== 'string' || !/^([0-9a-f]{2})+$/.test(data.witnessScript)) fail('witnessScript');
  if (typeof data.htlcAddress !== 'string' || !data.htlcAddress.startsWith('tb1')) fail('htlcAddress');
  if (typeof data.suiRecipient !== 'string' || !/^0x[0-9a-f]{64}$/.test(data.suiRecipient)) fail('suiRecipient');
  for (const field of ['locktime', 'btcSats', 'quoteExpiresAt', 'createdAt'] as const) {
    if (typeof data[field] !== 'number' || !Number.isInteger(data[field])) fail(field);
  }
  if (typeof data.suiAmount !== 'string' || !/^\d+$/.test(data.suiAmount)) fail('suiAmount');
  if (typeof data.apiUrl !== 'string') fail('apiUrl');
  return data as unknown as RecoveryFile;
}

export function serializeRecoveryFile(recovery: RecoveryFile): string {
  return JSON.stringify(recovery, null, 2);
}

export function recoveryFileName(recovery: RecoveryFile): string {
  return `hashbridge-recovery-${recovery.swapId}.json`;
}
