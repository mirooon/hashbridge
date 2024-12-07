import * as bitcoin from 'bitcoinjs-lib';
import { describe, expect, it } from 'vitest';
import { buildClaimTx, buildRefundTx } from '../src/btc-tx';
import { ECPair } from '../src/ecc';
import { BTC_NETWORK } from '../src/network';

const hex = (h: string) => new Uint8Array(Buffer.from(h, 'hex'));
const kp = ECPair.fromPrivateKey(Buffer.from('00'.repeat(31) + '01', 'hex'));
const KEY = { privateKey: new Uint8Array(kp.privateKey!), publicKey: new Uint8Array(kp.publicKey) };
// Any script works for signing tests; this is the T4 fixture script.
const WS = hex(
  '6382012088a820' + '11'.repeat(32) + '8821' + '02' + '22'.repeat(32) + '6703d0b003b17521' + '03' + '33'.repeat(32) + '68ac',
);
const DEST = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
const PREIMAGE = hex('07'.repeat(32));

function verifies(tx: bitcoin.Transaction, index: number, value: number): boolean {
  const { signature, hashType } = bitcoin.script.signature.decode(tx.ins[index]!.witness[0]!);
  const sighash = tx.hashForWitnessV0(index, Buffer.from(WS), value, hashType);
  return ECPair.fromPublicKey(Buffer.from(KEY.publicKey)).verify(sighash, signature);
}

describe('buildClaimTx', () => {
  const base = { utxo: { txid: 'aa'.repeat(32), vout: 1, value: 100_000 }, witnessScript: WS, preimage: PREIMAGE, claimKey: KEY, destination: DEST, feeRate: 2 };

  it('spends the HTLC through the hash branch', () => {
    const built = buildClaimTx(base);
    const tx = bitcoin.Transaction.fromHex(built.hex);
    expect(tx.getId()).toBe(built.txid);
    expect(Buffer.from(tx.ins[0]!.hash).reverse().toString('hex')).toBe('aa'.repeat(32));
    expect(tx.ins[0]!.index).toBe(1);
    expect(tx.ins[0]!.sequence).toBe(0xfffffffd);
    expect(tx.locktime).toBe(0);
    const w = tx.ins[0]!.witness;
    expect(w).toHaveLength(4);
    expect(w[1]!.toString('hex')).toBe('07'.repeat(32));
    expect(w[2]!.toString('hex')).toBe('01');
    expect(w[3]!.toString('hex')).toBe(Buffer.from(WS).toString('hex'));
    expect(verifies(tx, 0, 100_000)).toBe(true);
  });

  it('pays everything minus a fee that matches the fee rate', () => {
    const built = buildClaimTx(base);
    const tx = bitcoin.Transaction.fromHex(built.hex);
    expect(tx.outs[0]!.value).toBe(100_000 - built.fee);
    expect(tx.outs[0]!.script.toString('hex')).toBe(bitcoin.address.toOutputScript(DEST, BTC_NETWORK).toString('hex'));
    expect(built.fee).toBeGreaterThanOrEqual(built.vsize * 2);
    expect(built.fee).toBeLessThanOrEqual((built.vsize + 3) * 2);
  });

  it('rejects preimages that are not 32 bytes', () => {
    expect(() => buildClaimTx({ ...base, preimage: hex('07'.repeat(31)) })).toThrow(/32 bytes/);
  });

  it('refuses to create a dust output', () => {
    expect(() => buildClaimTx({ ...base, utxo: { ...base.utxo, value: 1_000 }, feeRate: 5 })).toThrow(/dust/);
  });

  it('rejects a destination on another network', () => {
    expect(() => buildClaimTx({ ...base, destination: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4' })).toThrow(/destination/);
  });
});

describe('buildRefundTx', () => {
  const utxos = [
    { txid: 'aa'.repeat(32), vout: 0, value: 60_000 },
    { txid: 'bb'.repeat(32), vout: 2, value: 40_000 },
  ];
  const base = { utxos, witnessScript: WS, locktime: 241_872, refundKey: KEY, destination: DEST, feeRate: 2 };

  it('spends every UTXO through the timelock branch', () => {
    const built = buildRefundTx(base);
    const tx = bitcoin.Transaction.fromHex(built.hex);
    expect(tx.locktime).toBe(241_872);
    expect(tx.ins).toHaveLength(2);
    tx.ins.forEach((input, i) => {
      expect(input.sequence).toBe(0xfffffffd);
      expect(input.witness).toHaveLength(3);
      expect(input.witness[1]!.length).toBe(0);
      expect(input.witness[2]!.toString('hex')).toBe(Buffer.from(WS).toString('hex'));
      expect(verifies(tx, i, utxos[i]!.value)).toBe(true);
    });
    expect(tx.outs[0]!.value).toBe(100_000 - built.fee);
  });

  it('needs at least one UTXO', () => {
    expect(() => buildRefundTx({ ...base, utxos: [] })).toThrow(/no utxos/);
  });
});
