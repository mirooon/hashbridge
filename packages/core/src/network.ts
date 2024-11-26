import * as bitcoin from 'bitcoinjs-lib';

/** Signet shares testnet address parameters (bech32 prefix "tb"). */
export const BTC_NETWORK = bitcoin.networks.testnet;
export const SATS_PER_BTC = 100_000_000;
export const MIST_PER_SUI = 1_000_000_000n;
export const DUST_SATS = 546;
