import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

const BASE = {
  BTC_WIF: 'wif',
  SUI_PRIVATE_KEY: 'suiprivkey1xyz',
  HTLC_PACKAGE_ID: '0x' + 'A'.repeat(64),
  RATE: '12400',
};

describe('loadConfig', () => {
  it('lists every missing required variable', () => {
    expect(() => loadConfig({})).toThrow('Missing required env vars: BTC_WIF, SUI_PRIVATE_KEY, HTLC_PACKAGE_ID, RATE');
  });

  it('applies defaults from the spec', () => {
    const c = loadConfig(BASE);
    expect(c).toMatchObject({
      port: 8787,
      htlcPackageId: '0x' + 'a'.repeat(64),
      rate: 12_400,
      spreadBps: 50,
      quoteTtlS: 60,
      minConf: 0,
      btcLocktimeBlocks: 72,
      suiTimeoutMs: 3_600_000,
      safetyBlocks: 12,
      minBtcSats: 10_000,
      maxBtcSats: 1_000_000,
      pollIntervalMs: 3_000,
      dbPath: './hashbridge.db',
      esploraUrl: 'https://mempool.space/signet/api',
      suiRpcUrl: 'https://fullnode.testnet.sui.io:443',
    });
    expect(c.gasReserveMist).toBe(200_000_000n);
  });

  it('parses overrides', () => {
    const c = loadConfig({ ...BASE, MIN_CONF: '1', RATE: '0.5', GAS_RESERVE_MIST: '5' });
    expect(c.minConf).toBe(1);
    expect(c.rate).toBe(0.5);
    expect(c.gasReserveMist).toBe(5n);
  });

  it('rejects malformed numbers and package ids', () => {
    expect(() => loadConfig({ ...BASE, MIN_CONF: 'one' })).toThrow('MIN_CONF must be an integer, got "one"');
    expect(() => loadConfig({ ...BASE, SAFETY_BLOCKS: '1.5' })).toThrow(/SAFETY_BLOCKS/);
    expect(() => loadConfig({ ...BASE, HTLC_PACKAGE_ID: '0x123' })).toThrow(/HTLC_PACKAGE_ID/);
  });

  it('refuses a Sui timeout that outlives the BTC locktime', () => {
    expect(() => loadConfig({ ...BASE, BTC_LOCKTIME_BLOCKS: '2', SUI_TIMEOUT_MS: '3600000' })).toThrow(/SUI_TIMEOUT_MS/);
    expect(() => loadConfig({ ...BASE, BTC_LOCKTIME_BLOCKS: '2', SUI_TIMEOUT_MS: '600000' })).not.toThrow();
  });

  it('refuses min above max', () => {
    expect(() => loadConfig({ ...BASE, MIN_BTC_SATS: '5', MAX_BTC_SATS: '4' })).toThrow(/MIN_BTC_SATS/);
  });
});
