export type SwapStatus =
  | 'AWAITING_DEPOSIT'
  | 'DEPOSIT_SEEN'
  | 'SUI_LOCKED'
  | 'SUI_CLAIMED'
  | 'BTC_CLAIMED'
  | 'EXPIRED'
  | 'REJECTED'
  | 'SUI_REFUNDED';

export const TERMINAL_STATUSES: readonly SwapStatus[] = ['BTC_CLAIMED', 'EXPIRED', 'REJECTED', 'SUI_REFUNDED'];

export function isTerminal(status: SwapStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** BTC hex values: lowercase, no 0x. Sui addresses: 0x + 64 lowercase hex. MIST amounts: decimal strings. */
export interface CreateSwapRequest {
  hash: string;
  refundPubkey: string;
  suiRecipient: string;
  btcSats: number;
}

export interface CreateSwapResponse {
  swapId: string;
  botPubkey: string;
  locktime: number;
  htlcAddress: string;
  witnessScript: string;
  suiAmount: string;
  quoteExpiresAt: number;
}

export interface SwapView {
  swapId: string;
  status: SwapStatus;
  createdAt: number;
  hash: string;
  htlcAddress: string;
  witnessScript: string;
  locktime: number;
  btcSats: number;
  suiRecipient: string;
  suiAmount: string;
  quoteExpiresAt: number;
  depositTxid: string | null;
  depositSats: number | null;
  htlcObjectId: string | null;
  suiDeadlineMs: number | null;
  lockDigest: string | null;
  claimDigest: string | null;
  btcClaimTxid: string | null;
  refundDigest: string | null;
  rejectReason: string | null;
}

export interface ClaimRequest {
  preimage: string;
}

export interface ClaimResponse {
  digest: string;
}

export interface HealthResponse {
  botPubkey: string;
  suiAddress: string;
  btcSats: number;
  suiMist: string;
  tipHeight: number;
  rate: number;
  spreadBps: number;
  minBtcSats: number;
  maxBtcSats: number;
}

export interface RecoveryFile {
  version: 1;
  swapId: string;
  secret: string;
  hash: string;
  refundPrivkey: string;
  refundPubkey: string;
  botPubkey: string;
  locktime: number;
  witnessScript: string;
  htlcAddress: string;
  suiRecipient: string;
  btcSats: number;
  suiAmount: string;
  quoteExpiresAt: number;
  apiUrl: string;
  createdAt: number;
}

export interface Utxo {
  txid: string;
  vout: number;
  value: number;
  confirmed: boolean;
  blockHeight: number | null;
}

export interface SpendInput {
  txid: string;
  vout: number;
  value: number;
}

export interface BtcKey {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
}

export interface BtcChain {
  tipHeight(): Promise<number>;
  addressUtxos(address: string): Promise<Utxo[]>;
  broadcast(txHex: string): Promise<string>;
  feeRate(): Promise<number>;
}
