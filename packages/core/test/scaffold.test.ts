import { describe, expect, it } from 'vitest';
import { ECPair } from '../src/ecc';
import { mempoolTxUrl, suiscanObjectUrl, suiscanTxUrl } from '../src/links';
import { DUST_SATS, MIST_PER_SUI } from '../src/network';
import { isTerminal } from '../src/types';

describe('scaffold', () => {
  it('classifies terminal statuses', () => {
    expect(isTerminal('BTC_CLAIMED')).toBe(true);
    expect(isTerminal('REJECTED')).toBe(true);
    expect(isTerminal('SUI_LOCKED')).toBe(false);
  });

  it('derives the generator point from private key 1', () => {
    const kp = ECPair.fromPrivateKey(Buffer.from('00'.repeat(31) + '01', 'hex'));
    expect(Buffer.from(kp.publicKey).toString('hex')).toBe(
      '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
    );
  });

  it('builds explorer links and exposes constants', () => {
    expect(mempoolTxUrl('ab')).toBe('https://mempool.space/signet/tx/ab');
    expect(suiscanTxUrl('D1')).toBe('https://suiscan.xyz/testnet/tx/D1');
    expect(suiscanObjectUrl('0x1')).toBe('https://suiscan.xyz/testnet/object/0x1');
    expect(DUST_SATS).toBe(546);
    expect(MIST_PER_SUI).toBe(1_000_000_000n);
  });
});
