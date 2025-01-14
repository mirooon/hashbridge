import * as bitcoin from 'bitcoinjs-lib';
import { describe, expect, it } from 'vitest';
import { stepDetectClaim, stepSuiClaimed } from '../src/engine/claim';
import type { SwapRecord } from '../src/types';
import { BOT_BTC_ADDRESS, PREIMAGE, T0, makeEnv, makeSwap } from './fakes';

const locked = (over: Partial<SwapRecord> = {}) =>
  makeSwap({
    status: 'SUI_LOCKED', depositTxid: 'aa'.repeat(32), depositVout: 1, depositSats: 100_000, depositFirstSeenAt: T0,
    htlcObjectId: 'htlc-1', suiDeadlineMs: T0 + 3_600_000, lockDigest: 'digest-0', ...over,
  });
const claimed = (over: Partial<SwapRecord> = {}) => locked({ status: 'SUI_CLAIMED', preimage: PREIMAGE, claimDigest: 'claim-digest', ...over });

describe('stepDetectClaim', () => {
  it('returns false while nobody has claimed', async () => {
    const env = makeEnv();
    env.repo.insert(locked());
    expect(await stepDetectClaim(env.repo.get('swap-1')!, env.deps)).toBe(false);
    expect(env.repo.get('swap-1')!.status).toBe('SUI_LOCKED');
  });

  it('takes the preimage from the Claimed event', async () => {
    const env = makeEnv();
    env.repo.insert(locked());
    env.sui.claims.set('htlc-1', { digest: 'claim-digest', preimage: PREIMAGE });
    expect(await stepDetectClaim(env.repo.get('swap-1')!, env.deps)).toBe(true);
    expect(env.repo.get('swap-1')).toMatchObject({ status: 'SUI_CLAIMED', preimage: PREIMAGE, claimDigest: 'claim-digest' });
  });

  it('finishes a relayed claim that was pending at restart', async () => {
    const env = makeEnv();
    env.repo.insert(locked({ preimage: PREIMAGE, pendingTx: { kind: 'claim', digest: 'digest-5', bytes: 'AA==', signature: 'c2ln' } }));
    env.sui.executed.set('digest-5', { digest: 'digest-5', success: true, error: null, htlcObjectId: null });
    expect(await stepDetectClaim(env.repo.get('swap-1')!, env.deps)).toBe(true);
    expect(env.repo.get('swap-1')).toMatchObject({ status: 'SUI_CLAIMED', claimDigest: 'digest-5', pendingTx: null });
  });

  it('does not mark a relayed claim that landed with success false as claimed', async () => {
    const env = makeEnv();
    env.repo.insert(locked({ preimage: PREIMAGE, pendingTx: { kind: 'claim', digest: 'digest-5', bytes: 'AA==', signature: 'c2ln' } }));
    env.sui.executed.set('digest-5', { digest: 'digest-5', success: false, error: 'MoveAbort', htlcObjectId: null });
    expect(await stepDetectClaim(env.repo.get('swap-1')!, env.deps)).toBe(false);
    expect(env.repo.get('swap-1')).toMatchObject({ status: 'SUI_LOCKED', pendingTx: null, preimage: PREIMAGE });
  });
});

describe('stepSuiClaimed', () => {
  it('claims the BTC deposit to the bot address', async () => {
    const env = makeEnv();
    env.repo.insert(claimed());
    await stepSuiClaimed(env.repo.get('swap-1')!, env.deps);
    expect(env.btc.broadcasted).toHaveLength(1);
    const tx = bitcoin.Transaction.fromHex(env.btc.broadcasted[0]!);
    expect(Buffer.from(tx.ins[0]!.hash).reverse().toString('hex')).toBe('aa'.repeat(32));
    expect(tx.ins[0]!.index).toBe(1);
    expect(tx.ins[0]!.witness[1]!.toString('hex')).toBe(PREIMAGE);
    expect(tx.outs[0]!.script.toString('hex')).toBe(bitcoin.address.toOutputScript(BOT_BTC_ADDRESS, bitcoin.networks.testnet).toString('hex'));
    expect(env.repo.get('swap-1')).toMatchObject({ status: 'BTC_CLAIMED', btcClaimTxid: tx.getId() });
  });

  it('treats an already-known claim tx as done without rebuilding it', async () => {
    const env = makeEnv();
    env.repo.insert(claimed({ btcClaimTxHex: 'deadbeef', btcClaimTxid: 'f'.repeat(64) }));
    env.btc.broadcastError = new Error('broadcast failed: 400 sendrawtransaction RPC error: {"code":-27,"message":"Transaction already in block chain"}');
    await stepSuiClaimed(env.repo.get('swap-1')!, env.deps);
    expect(env.btc.broadcasted).toEqual(['deadbeef']);
    expect(env.repo.get('swap-1')!.status).toBe('BTC_CLAIMED');
  });

  it('does not treat an unrelated "already" broadcast error as claimed', async () => {
    const env = makeEnv();
    env.repo.insert(claimed());
    env.btc.broadcastError = new Error('broadcast failed: 400 input was already spent');
    await expect(stepSuiClaimed(env.repo.get('swap-1')!, env.deps)).rejects.toThrow(/already spent/);
    expect(env.repo.get('swap-1')!.status).toBe('SUI_CLAIMED');
  });

  it('keeps the built tx and retries it after other broadcast errors', async () => {
    const env = makeEnv();
    env.repo.insert(claimed());
    env.btc.broadcastError = new Error('broadcast failed: 503 unavailable');
    await expect(stepSuiClaimed(env.repo.get('swap-1')!, env.deps)).rejects.toThrow(/503/);
    expect(env.repo.get('swap-1')).toMatchObject({ status: 'SUI_CLAIMED' });
    expect(env.repo.get('swap-1')!.btcClaimTxHex).not.toBeNull();
    env.btc.broadcastError = null;
    await stepSuiClaimed(env.repo.get('swap-1')!, env.deps);
    expect(env.btc.broadcasted[1]).toBe(env.btc.broadcasted[0]);
    expect(env.repo.get('swap-1')!.status).toBe('BTC_CLAIMED');
  });

  it('refuses a preimage that does not match the hash', async () => {
    const env = makeEnv();
    env.repo.insert(claimed({ preimage: '08'.repeat(32) }));
    await expect(stepSuiClaimed(env.repo.get('swap-1')!, env.deps)).rejects.toThrow(/preimage/);
    expect(env.btc.broadcasted).toHaveLength(0);
  });
});
