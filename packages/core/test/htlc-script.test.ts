import * as bitcoin from 'bitcoinjs-lib';
import { describe, expect, it } from 'vitest';
import { buildWitnessScript, htlcAddress, witnessScriptAsm } from '../src/htlc-script';
import { BTC_NETWORK } from '../src/network';

const hex = (h: string) => new Uint8Array(Buffer.from(h, 'hex'));
const params = {
  hash: hex('11'.repeat(32)),
  claimPubkey: hex('02' + '22'.repeat(32)),
  refundPubkey: hex('03' + '33'.repeat(32)),
  locktime: 241_872,
};
const EXPECTED_SCRIPT =
  '63820120' + '88' + 'a8' + '20' + '11'.repeat(32) + '88' + '21' + '02' + '22'.repeat(32) +
  '67' + '03d0b003' + 'b1' + '75' + '21' + '03' + '33'.repeat(32) + '68' + 'ac';

describe('buildWitnessScript', () => {
  it('encodes the HTLC from the spec byte for byte', () => {
    expect(Buffer.from(buildWitnessScript(params)).toString('hex')).toBe(EXPECTED_SCRIPT);
  });

  it('renders readable ASM', () => {
    const asm = witnessScriptAsm(buildWitnessScript(params));
    expect(asm).toContain('OP_IF OP_SIZE 20 OP_EQUALVERIFY OP_SHA256');
    expect(asm).toContain('OP_CHECKLOCKTIMEVERIFY OP_DROP');
    expect(asm.endsWith('OP_ENDIF OP_CHECKSIG')).toBe(true);
  });

  it('rejects malformed inputs', () => {
    expect(() => buildWitnessScript({ ...params, hash: hex('11'.repeat(31)) })).toThrow(/hash/);
    expect(() => buildWitnessScript({ ...params, claimPubkey: hex('04' + '22'.repeat(32)) })).toThrow(/claimPubkey/);
    expect(() => buildWitnessScript({ ...params, refundPubkey: hex('03' + '33'.repeat(31)) })).toThrow(/refundPubkey/);
    expect(() => buildWitnessScript({ ...params, locktime: 0 })).toThrow(/locktime/);
    expect(() => buildWitnessScript({ ...params, locktime: 500_000_000 })).toThrow(/locktime/);
    expect(() => buildWitnessScript({ ...params, locktime: 1.5 })).toThrow(/locktime/);
  });
});

describe('htlcAddress', () => {
  it('matches the known P2WSH address of the fixture', () => {
    expect(htlcAddress(buildWitnessScript(params))).toBe('tb1qtu8n2s68vnsfuezt4tutq54c689y28p9gffd2e3s3s3tkzawh6ms3u4z6h');
  });

  it('commits to sha256(witnessScript)', () => {
    const ws = buildWitnessScript(params);
    const out = bitcoin.address.toOutputScript(htlcAddress(ws), BTC_NETWORK);
    expect(out.toString('hex')).toBe('0020' + bitcoin.crypto.sha256(Buffer.from(ws)).toString('hex'));
  });
});
