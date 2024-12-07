import * as bitcoin from 'bitcoinjs-lib';
import { ECPair } from './ecc';
import { BTC_NETWORK, DUST_SATS } from './network';
import type { BtcKey, SpendInput } from './types';

export interface BuiltTx {
  hex: string;
  txid: string;
  fee: number;
  vsize: number;
}

export interface ClaimTxParams {
  utxo: SpendInput;
  witnessScript: Uint8Array;
  preimage: Uint8Array;
  claimKey: BtcKey;
  destination: string;
  feeRate: number;
}

export interface RefundTxParams {
  utxos: SpendInput[];
  witnessScript: Uint8Array;
  locktime: number;
  refundKey: BtcKey;
  destination: string;
  feeRate: number;
}

const SEQUENCE_RBF = 0xfffffffd;
const { SIGHASH_ALL } = bitcoin.Transaction;

function outputScript(destination: string): Buffer {
  try {
    return bitcoin.address.toOutputScript(destination, BTC_NETWORK);
  } catch {
    throw new Error(`invalid destination address for signet: ${destination}`);
  }
}

function txidBuffer(txid: string): Buffer {
  return Buffer.from(txid, 'hex').reverse();
}

function signInput(tx: bitcoin.Transaction, index: number, witnessScript: Uint8Array, value: number, key: BtcKey): Buffer {
  const sighash = tx.hashForWitnessV0(index, Buffer.from(witnessScript), value, SIGHASH_ALL);
  const signature = ECPair.fromPrivateKey(Buffer.from(key.privateKey)).sign(sighash);
  return bitcoin.script.signature.encode(Buffer.from(signature), SIGHASH_ALL);
}

/** Builds with a zero fee, measures vsize, then rebuilds until the fee covers the size (DER signatures vary by a byte). */
function withFee(build: (outValue: number) => bitcoin.Transaction, inputTotal: number, feeRate: number): BuiltTx {
  let fee = 0;
  let tx = build(inputTotal);
  for (let i = 0; i < 3; i++) {
    const needed = Math.ceil((tx.virtualSize() + 1) * feeRate);
    if (needed <= fee) break;
    fee = needed;
    tx = build(inputTotal - fee);
  }
  return { hex: tx.toHex(), txid: tx.getId(), fee, vsize: tx.virtualSize() };
}

function assertOutput(value: number): void {
  if (value < DUST_SATS) throw new Error(`output of ${value} sats would be dust after fees`);
}

export function buildClaimTx(p: ClaimTxParams): BuiltTx {
  if (p.preimage.length !== 32) throw new Error('preimage must be 32 bytes');
  const out = outputScript(p.destination);
  const build = (outValue: number) => {
    assertOutput(outValue);
    const tx = new bitcoin.Transaction();
    tx.version = 2;
    tx.addInput(txidBuffer(p.utxo.txid), p.utxo.vout, SEQUENCE_RBF);
    tx.addOutput(out, outValue);
    const sig = signInput(tx, 0, p.witnessScript, p.utxo.value, p.claimKey);
    tx.setWitness(0, [sig, Buffer.from(p.preimage), Buffer.from([1]), Buffer.from(p.witnessScript)]);
    return tx;
  };
  return withFee(build, p.utxo.value, p.feeRate);
}

export function buildRefundTx(p: RefundTxParams): BuiltTx {
  if (p.utxos.length === 0) throw new Error('no utxos to refund');
  const out = outputScript(p.destination);
  const total = p.utxos.reduce((sum, u) => sum + u.value, 0);
  const build = (outValue: number) => {
    assertOutput(outValue);
    const tx = new bitcoin.Transaction();
    tx.version = 2;
    tx.locktime = p.locktime;
    for (const u of p.utxos) tx.addInput(txidBuffer(u.txid), u.vout, SEQUENCE_RBF);
    tx.addOutput(out, outValue);
    p.utxos.forEach((u, i) => {
      const sig = signInput(tx, i, p.witnessScript, u.value, p.refundKey);
      tx.setWitness(i, [sig, Buffer.alloc(0), Buffer.from(p.witnessScript)]);
    });
    return tx;
  };
  return withFee(build, total, p.feeRate);
}
