export const mempoolTxUrl = (txid: string): string => `https://mempool.space/signet/tx/${txid}`;
export const mempoolAddressUrl = (address: string): string => `https://mempool.space/signet/address/${address}`;
export const suiscanTxUrl = (digest: string): string => `https://suiscan.xyz/testnet/tx/${digest}`;
export const suiscanObjectUrl = (id: string): string => `https://suiscan.xyz/testnet/object/${id}`;
