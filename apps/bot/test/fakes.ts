import { TERMINAL_STATUSES, type BtcChain, type BtcKey, type Utxo } from '@hashbridge/core/types';
import type {
  BotConfig, ClaimEventInfo, EngineDeps, LockParams, SignedTx, SuiChain, SuiTxKind, SuiTxResult, SwapRecord, SwapRepo,
} from '../src/types';

const hex = (h: string) => new Uint8Array(Buffer.from(h, 'hex'));

/** Private key 1: public key is the secp256k1 generator, address is the BIP173 test vector. */
export const BOT_KEY: BtcKey = {
  privateKey: hex('00'.repeat(31) + '01'),
  publicKey: hex('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'),
};
export const BOT_BTC_ADDRESS = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
export const PREIMAGE = '07'.repeat(32);
export const HASH = '4bb06f8e4e3a7715d201d573d0aa423762e55dabd61a2c02278fa56cc6d294e0';
export const USER_SUI = '0x' + 'a'.repeat(64);
export const T0 = 1_700_000_000_000;
/** T4 fixture script (hash 0x11…). Signing code does not care which script it is. */
export const FIXTURE_WITNESS_SCRIPT =
  '6382012088a820' + '11'.repeat(32) + '8821' + '02' + '22'.repeat(32) + '6703d0b003b17521' + '03' + '33'.repeat(32) + '68ac';
export const FIXTURE_HTLC_ADDRESS = 'tb1qtu8n2s68vnsfuezt4tutq54c689y28p9gffd2e3s3s3tkzawh6ms3u4z6h';

export function testConfig(over: Partial<BotConfig> = {}): BotConfig {
  return {
    port: 0, btcWif: 'unused', suiPrivateKey: 'unused', htlcPackageId: '0x' + '1'.repeat(64),
    suiRpcUrl: 'http://127.0.0.1:1', esploraUrl: 'http://127.0.0.1:1', rate: 12_400, spreadBps: 50, quoteTtlS: 60,
    minConf: 0, btcLocktimeBlocks: 72, suiTimeoutMs: 3_600_000, safetyBlocks: 12, minBtcSats: 10_000,
    maxBtcSats: 1_000_000, gasReserveMist: 200_000_000n, pollIntervalMs: 10, dbPath: ':memory:', ...over,
  };
}

export function makeSwap(over: Partial<SwapRecord> = {}): SwapRecord {
  return {
    swapId: 'swap-1', status: 'AWAITING_DEPOSIT', createdAt: T0, hash: HASH, htlcAddress: FIXTURE_HTLC_ADDRESS,
    witnessScript: FIXTURE_WITNESS_SCRIPT, locktime: 241_872, btcSats: 100_000, suiRecipient: USER_SUI,
    suiAmount: '12338000000', quoteExpiresAt: T0 + 60_000, depositTxid: null, depositSats: null, htlcObjectId: null,
    suiDeadlineMs: null, lockDigest: null, claimDigest: null, btcClaimTxid: null, refundDigest: null,
    rejectReason: null, refundPubkey: '03' + '33'.repeat(32), depositVout: null, depositFirstSeenAt: null,
    preimage: null, btcClaimTxHex: null, pendingTx: null, ...over,
  };
}

export function memoryRepo(): SwapRepo & { all(): SwapRecord[] } {
  const rows = new Map<string, SwapRecord>();
  const clone = (s: SwapRecord) => structuredClone(s);
  return {
    insert(swap) {
      if (rows.has(swap.swapId)) throw new Error('duplicate swapId');
      if ([...rows.values()].some((r) => r.hash === swap.hash)) throw new Error('duplicate hash');
      rows.set(swap.swapId, clone(swap));
    },
    get(swapId) {
      const row = rows.get(swapId);
      return row ? clone(row) : undefined;
    },
    findByHash(hash) {
      const row = [...rows.values()].find((r) => r.hash === hash);
      return row ? clone(row) : undefined;
    },
    update(swapId, patch) {
      const current = rows.get(swapId);
      if (!current) throw new Error(`swap ${swapId} not found`);
      const next = { ...current, ...patch, swapId: current.swapId };
      rows.set(swapId, clone(next));
      return clone(next);
    },
    listActive() {
      return [...rows.values()].filter((r) => !TERMINAL_STATUSES.includes(r.status)).map(clone);
    },
    all() {
      return [...rows.values()].map(clone);
    },
  };
}

export class FakeBtcChain implements BtcChain {
  tip = 241_800;
  utxos = new Map<string, Utxo[]>();
  failAddresses = new Set<string>();
  broadcasted: string[] = [];
  broadcastError: Error | null = null;
  fee = 2;

  async tipHeight() {
    return this.tip;
  }

  async addressUtxos(address: string) {
    if (this.failAddresses.has(address)) throw new Error(`esplora down for ${address}`);
    return structuredClone(this.utxos.get(address) ?? []);
  }

  async broadcast(txHex: string) {
    this.broadcasted.push(txHex);
    if (this.broadcastError) throw this.broadcastError;
    return `txid-${this.broadcasted.length}`;
  }

  async feeRate() {
    return this.fee;
  }
}

export class FakeSuiChain implements SuiChain {
  balance = 1_000_000_000_000n;
  signed: SignedTx[] = [];
  executed = new Map<string, SuiTxResult>();
  claims = new Map<string, ClaimEventInfo>();
  lastLock: LockParams | null = null;
  locks: LockParams[] = [];
  lastClaim: { htlcObjectId: string; preimage: string } | null = null;
  lastRefund: string | null = null;
  executeError: Error | null = null;
  nextFails = false;
  /** Lock txs succeed but carry no parseable Locked event (e.g. after a package upgrade). */
  noLockedEvent = false;
  executeDelayMs = 0;
  private counter = 0;

  address() {
    return '0x' + 'b'.repeat(64);
  }

  async balanceMist() {
    return this.balance;
  }

  async signLock(params: LockParams) {
    this.lastLock = params;
    this.locks.push(params);
    return this.sign('lock');
  }

  async signClaim(htlcObjectId: string, preimage: string) {
    this.lastClaim = { htlcObjectId, preimage };
    return this.sign('claim');
  }

  async signRefund(htlcObjectId: string) {
    this.lastRefund = htlcObjectId;
    return this.sign('refund');
  }

  async execute(tx: SignedTx): Promise<SuiTxResult> {
    if (this.executeDelayMs > 0) await new Promise((r) => setTimeout(r, this.executeDelayMs));
    if (this.executeError) {
      const err = this.executeError;
      this.executeError = null;
      throw err;
    }
    const failed = this.nextFails;
    this.nextFails = false;
    const result: SuiTxResult = {
      digest: tx.digest,
      success: !failed,
      error: failed ? 'MoveAbort(htlc, 3)' : null,
      htlcObjectId: tx.kind === 'lock' && !failed && !this.noLockedEvent ? `htlc-of-${tx.digest}` : null,
    };
    this.executed.set(tx.digest, result);
    return result;
  }

  async lookup(digest: string) {
    return this.executed.get(digest) ?? null;
  }

  async findClaim(htlcObjectId: string) {
    return this.claims.get(htlcObjectId) ?? null;
  }

  private sign(kind: SuiTxKind): SignedTx {
    const tx = { kind, digest: `digest-${++this.counter}`, bytes: 'AA==', signature: 'c2ln' };
    this.signed.push(tx);
    return tx;
  }
}

export interface TestEnv {
  deps: EngineDeps;
  repo: ReturnType<typeof memoryRepo>;
  btc: FakeBtcChain;
  sui: FakeSuiChain;
  logs: string[];
  setNow(ms: number): void;
}

export function makeEnv(config: Partial<BotConfig> = {}): TestEnv {
  const repo = memoryRepo();
  const btc = new FakeBtcChain();
  const sui = new FakeSuiChain();
  const logs: string[] = [];
  let now = T0 + 10_000;
  const deps: EngineDeps = {
    repo, btc, sui, config: testConfig(config), botKey: BOT_KEY, now: () => now,
    log: (msg) => { logs.push(msg); },
  };
  return { deps, repo, btc, sui, logs, setNow: (ms) => { now = ms; } };
}
