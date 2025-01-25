import { buildWitnessScript, htlcAddress } from '@hashbridge/core/htlc-script';
import { btcKeyFromPrivateKeyHex } from '@hashbridge/core/keys';
import { bytesToHex, hashSecret, hexToBytes } from '@hashbridge/core/secret';
import type { CreateSwapResponse } from '@hashbridge/core/types';
import { describe, expect, it } from 'vitest';
import { buildRecovery, parseSuiAddress, prepareSwap, verifyBotResponse } from '../src/lib/new-swap';

const BOT_PUB = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const TIP = 241_800;

function honestResponse(prep: ReturnType<typeof prepareSwap>, locktime = TIP + 72): CreateSwapResponse {
  const ws = buildWitnessScript({ hash: hexToBytes(prep.hash), claimPubkey: hexToBytes(BOT_PUB), refundPubkey: hexToBytes(prep.refundPubkey), locktime });
  return { swapId: 'swap-1', botPubkey: BOT_PUB, locktime, htlcAddress: htlcAddress(ws), witnessScript: bytesToHex(ws), suiAmount: '12338000000', quoteExpiresAt: 99 };
}

describe('parseSuiAddress', () => {
  it('normalizes valid addresses and rejects the rest', () => {
    expect(parseSuiAddress('  0x' + 'A'.repeat(64) + ' ')).toBe('0x' + 'a'.repeat(64));
    expect(parseSuiAddress('a'.repeat(64))).toBeNull();
    expect(parseSuiAddress('0x' + 'a'.repeat(63))).toBeNull();
    expect(parseSuiAddress('0x' + 'g'.repeat(64))).toBeNull();
  });
});

describe('prepareSwap', () => {
  it('creates a matching secret/hash and key pair', () => {
    const prep = prepareSwap();
    expect(prep.hash).toBe(bytesToHex(hashSecret(hexToBytes(prep.secret))));
    expect(bytesToHex(btcKeyFromPrivateKeyHex(prep.refundPrivkey).publicKey)).toBe(prep.refundPubkey);
  });
});

describe('verifyBotResponse', () => {
  it('accepts an honest response', () => {
    const prep = prepareSwap();
    expect(verifyBotResponse(prep, honestResponse(prep), TIP)).toEqual([]);
  });

  it('rejects a tampered script', () => {
    const prep = prepareSwap();
    const res = honestResponse(prep);
    expect(verifyBotResponse(prep, { ...res, witnessScript: res.witnessScript.replace(/ac$/, 'ad') }, TIP).join()).toMatch(/script/);
  });

  it('rejects a tampered address', () => {
    const prep = prepareSwap();
    const res = honestResponse(prep);
    expect(verifyBotResponse(prep, { ...res, htlcAddress: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx' }, TIP).join()).toMatch(/address/);
  });

  it('rejects locktimes in the past or too far away', () => {
    const prep = prepareSwap();
    expect(verifyBotResponse(prep, honestResponse(prep, TIP), TIP).join()).toMatch(/past/);
    expect(verifyBotResponse(prep, honestResponse(prep, TIP + 301), TIP).join()).toMatch(/300 blocks/);
  });

  it('rejects a malformed bot key', () => {
    const prep = prepareSwap();
    expect(verifyBotResponse(prep, { ...honestResponse(prep), botPubkey: 'zz' }, TIP)).toEqual(['bot public key is malformed']);
  });
});

describe('buildRecovery', () => {
  it('collects everything needed to refund without the bot', () => {
    const prep = prepareSwap();
    const res = honestResponse(prep);
    const req = { hash: prep.hash, refundPubkey: prep.refundPubkey, suiRecipient: '0x' + 'a'.repeat(64), btcSats: 100_000 };
    expect(buildRecovery(prep, req, res, 'http://bot', 5)).toEqual({
      version: 1, swapId: 'swap-1', secret: prep.secret, hash: prep.hash, refundPrivkey: prep.refundPrivkey,
      refundPubkey: prep.refundPubkey, botPubkey: BOT_PUB, locktime: res.locktime, witnessScript: res.witnessScript,
      htlcAddress: res.htlcAddress, suiRecipient: req.suiRecipient, btcSats: 100_000, suiAmount: '12338000000',
      quoteExpiresAt: 99, apiUrl: 'http://bot', createdAt: 5,
    });
  });
});
