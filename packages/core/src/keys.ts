import * as bitcoin from 'bitcoinjs-lib';
import type { ECPairInterface } from 'ecpair';
import { ECPair } from './ecc';
import { BTC_NETWORK } from './network';
import type { BtcKey } from './types';

function toKey(kp: ECPairInterface): BtcKey {
  if (!kp.privateKey) throw new Error('key pair has no private key');
  return { privateKey: new Uint8Array(kp.privateKey), publicKey: new Uint8Array(kp.publicKey) };
}

export function randomBtcKey(): BtcKey {
  return toKey(ECPair.makeRandom({ network: BTC_NETWORK }));
}

export function btcKeyFromWif(wif: string): BtcKey {
  return toKey(ECPair.fromWIF(wif, BTC_NETWORK));
}

export function btcKeyFromPrivateKeyHex(hex: string): BtcKey {
  return toKey(ECPair.fromPrivateKey(Buffer.from(hex, 'hex'), { network: BTC_NETWORK }));
}

export function p2wpkhAddress(publicKey: Uint8Array): string {
  const { address } = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(publicKey), network: BTC_NETWORK });
  if (!address) throw new Error('cannot derive P2WPKH address');
  return address;
}

export function isCompressedPubkeyHex(hex: string): boolean {
  return /^0[23][0-9a-f]{64}$/.test(hex);
}
