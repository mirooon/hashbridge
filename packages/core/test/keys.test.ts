import { describe, expect, it } from 'vitest';
import { btcKeyFromPrivateKeyHex, btcKeyFromWif, isCompressedPubkeyHex, p2wpkhAddress, randomBtcKey } from '../src/keys';
import { bytesToHex } from '../src/secret';

const KEY1_WIF = 'cMahea7zqjxrtgAbB7LSGbcQUr1uX1ojuat9jZodMN87JcbXMTcA';
const KEY1_PUB = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const KEY1_ADDR = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';

describe('keys', () => {
  it('loads a testnet WIF', () => {
    const k = btcKeyFromWif(KEY1_WIF);
    expect(bytesToHex(k.publicKey)).toBe(KEY1_PUB);
    expect(bytesToHex(k.privateKey)).toBe('00'.repeat(31) + '01');
  });

  it('loads a raw private key', () => {
    expect(bytesToHex(btcKeyFromPrivateKeyHex('00'.repeat(31) + '01').publicKey)).toBe(KEY1_PUB);
  });

  it('derives the BIP173 P2WPKH test vector', () => {
    expect(p2wpkhAddress(btcKeyFromWif(KEY1_WIF).publicKey)).toBe(KEY1_ADDR);
  });

  it('generates compressed random keys', () => {
    const k = randomBtcKey();
    expect(k.privateKey).toHaveLength(32);
    expect(isCompressedPubkeyHex(bytesToHex(k.publicKey))).toBe(true);
  });

  it('rejects garbage keys', () => {
    expect(() => btcKeyFromWif('not-a-wif')).toThrow();
    expect(() => btcKeyFromPrivateKeyHex('00'.repeat(32))).toThrow();
  });

  it('recognises compressed public keys', () => {
    expect(isCompressedPubkeyHex(KEY1_PUB)).toBe(true);
    expect(isCompressedPubkeyHex('04' + '11'.repeat(32))).toBe(false);
    expect(isCompressedPubkeyHex(KEY1_PUB.toUpperCase())).toBe(false);
  });
});
