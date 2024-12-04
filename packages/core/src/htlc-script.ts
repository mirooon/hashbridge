import * as bitcoin from 'bitcoinjs-lib';
import { BTC_NETWORK } from './network';

export interface HtlcParams {
  hash: Uint8Array;
  claimPubkey: Uint8Array;
  refundPubkey: Uint8Array;
  /** Absolute block height. */
  locktime: number;
}

function assertCompressedPubkey(name: string, key: Uint8Array): void {
  if (key.length !== 33 || (key[0] !== 2 && key[0] !== 3)) {
    throw new Error(`${name} must be a 33-byte compressed public key`);
  }
}

/**
 * OP_IF   OP_SIZE 32 OP_EQUALVERIFY OP_SHA256 <hash> OP_EQUALVERIFY <claimPubkey>
 * OP_ELSE <locktime> OP_CHECKLOCKTIMEVERIFY OP_DROP <refundPubkey>
 * OP_ENDIF OP_CHECKSIG
 */
export function buildWitnessScript(p: HtlcParams): Uint8Array {
  if (p.hash.length !== 32) throw new Error('hash must be 32 bytes');
  assertCompressedPubkey('claimPubkey', p.claimPubkey);
  assertCompressedPubkey('refundPubkey', p.refundPubkey);
  if (!Number.isInteger(p.locktime) || p.locktime <= 0 || p.locktime >= 500_000_000) {
    throw new Error('locktime must be a block height between 1 and 499999999');
  }
  const op = bitcoin.opcodes;
  const compiled = bitcoin.script.compile([
    op.OP_IF,
    op.OP_SIZE,
    bitcoin.script.number.encode(32),
    op.OP_EQUALVERIFY,
    op.OP_SHA256,
    Buffer.from(p.hash),
    op.OP_EQUALVERIFY,
    Buffer.from(p.claimPubkey),
    op.OP_ELSE,
    bitcoin.script.number.encode(p.locktime),
    op.OP_CHECKLOCKTIMEVERIFY,
    op.OP_DROP,
    Buffer.from(p.refundPubkey),
    op.OP_ENDIF,
    op.OP_CHECKSIG,
  ]);
  return new Uint8Array(compiled);
}

export function htlcAddress(witnessScript: Uint8Array): string {
  const { address } = bitcoin.payments.p2wsh({
    redeem: { output: Buffer.from(witnessScript) },
    network: BTC_NETWORK,
  });
  if (!address) throw new Error('cannot derive P2WSH address');
  return address;
}

export function witnessScriptAsm(witnessScript: Uint8Array): string {
  return bitcoin.script.toASM(Buffer.from(witnessScript));
}
