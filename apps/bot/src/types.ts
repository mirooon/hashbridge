import type { BtcChain, BtcKey, SwapView } from '@hashbridge/core/types';

export type SuiTxKind = 'lock' | 'claim' | 'refund';

/** A Sui transaction signed but possibly not yet executed. `bytes` and `signature` are base64. */
export interface SignedTx {
  kind: SuiTxKind;
  digest: string;
  bytes: string;
  signature: string;
}

export interface SuiTxResult {
  digest: string;
  success: boolean;
  error: string | null;
  /** Set for lock transactions: id of the created Htlc object (from the Locked event). */
  htlcObjectId: string | null;
}

export interface LockParams {
  recipient: string;
  hash: string;
  amountMist: bigint;
  deadlineMs: number;
}

export interface ClaimEventInfo {
  digest: string;
  preimage: string;
}

export interface SuiChain {
  address(): string;
  balanceMist(): Promise<bigint>;
  signLock(params: LockParams): Promise<SignedTx>;
  signClaim(htlcObjectId: string, preimage: string): Promise<SignedTx>;
  signRefund(htlcObjectId: string): Promise<SignedTx>;
  /** Executes a signed tx and waits for it. Re-sending the same signed tx is safe. */
  execute(tx: SignedTx): Promise<SuiTxResult>;
  /** Returns the result of an already executed tx, or null if the network does not know it. */
  lookup(digest: string): Promise<SuiTxResult | null>;
  findClaim(htlcObjectId: string): Promise<ClaimEventInfo | null>;
}

export interface SwapRecord extends SwapView {
  refundPubkey: string;
  depositVout: number | null;
  depositFirstSeenAt: number | null;
  preimage: string | null;
  btcClaimTxHex: string | null;
  pendingTx: SignedTx | null;
}

export interface SwapRepo {
  insert(swap: SwapRecord): void;
  get(swapId: string): SwapRecord | undefined;
  findByHash(hash: string): SwapRecord | undefined;
  /** Merges `patch` into the stored record and returns the result. Throws if the swap does not exist. */
  update(swapId: string, patch: Partial<SwapRecord>): SwapRecord;
  listActive(): SwapRecord[];
}

export interface BotConfig {
  port: number;
  btcWif: string;
  suiPrivateKey: string;
  htlcPackageId: string;
  suiRpcUrl: string;
  esploraUrl: string;
  /** SUI per 1 BTC. */
  rate: number;
  spreadBps: number;
  quoteTtlS: number;
  minConf: number;
  btcLocktimeBlocks: number;
  suiTimeoutMs: number;
  safetyBlocks: number;
  minBtcSats: number;
  maxBtcSats: number;
  gasReserveMist: bigint;
  pollIntervalMs: number;
  dbPath: string;
}

export type Logger = (msg: string, extra?: Record<string, unknown>) => void;

export interface EngineDeps {
  repo: SwapRepo;
  btc: BtcChain;
  sui: SuiChain;
  config: BotConfig;
  botKey: BtcKey;
  now: () => number;
  log: Logger;
}
