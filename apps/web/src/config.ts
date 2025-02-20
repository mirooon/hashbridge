export const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8787';
export const ESPLORA_URL = import.meta.env.VITE_ESPLORA_URL ?? 'https://mempool.space/signet/api';
export const HTLC_PACKAGE_ID = import.meta.env.VITE_HTLC_PACKAGE_ID ?? '';
/** gRPC-web base URL of a Sui fullnode (public fullnodes no longer serve JSON-RPC). */
export const SUI_RPC_URL = 'https://fullnode.testnet.sui.io:443';
export const SUI_GRAPHQL_URL = import.meta.env.VITE_SUI_GRAPHQL_URL ?? 'https://graphql.testnet.sui.io/graphql';
