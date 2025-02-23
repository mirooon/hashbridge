import { readFileSync } from 'node:fs';
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

  it('requires the Sui deadline plus a 30 min BTC-claim margin to fit in SAFETY_BLOCKS', () => {
    // Defaults: 60 min + 30 min <= 12 blocks x 10 min.
    expect(() => loadConfig(BASE)).not.toThrow();
    expect(() => loadConfig({ ...BASE, SAFETY_BLOCKS: '2' })).toThrow(/SAFETY_BLOCKS/);
    expect(() => loadConfig({ ...BASE, SUI_TIMEOUT_MS: '5400000' })).not.toThrow();
    expect(() => loadConfig({ ...BASE, SUI_TIMEOUT_MS: '5400001' })).toThrow(/SUI_TIMEOUT_MS/);
    // The demo checklist's refund run.
    expect(() => loadConfig({ ...BASE, BTC_LOCKTIME_BLOCKS: '2', SUI_TIMEOUT_MS: '600000', SAFETY_BLOCKS: '12' })).not.toThrow();
  });

  it('accepts the values shipped in .env.example', () => {
    const lines = readFileSync(new URL('../.env.example', import.meta.url), 'utf8').split('\n');
    const example = Object.fromEntries(lines.filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    expect(example).toMatchObject({ SUI_TIMEOUT_MS: '3600000', SAFETY_BLOCKS: '12', BTC_LOCKTIME_BLOCKS: '72' });
    expect(() => loadConfig({ ...example, ...BASE })).not.toThrow();
  });

  it('requires at least one safety block', () => {
    expect(() => loadConfig({ ...BASE, SAFETY_BLOCKS: '0' })).toThrow('SAFETY_BLOCKS must be at least 1');
    expect(() => loadConfig({ ...BASE, SAFETY_BLOCKS: '-3' })).toThrow('SAFETY_BLOCKS must be at least 1');
  });

  it('refuses min above max', () => {
    expect(() => loadConfig({ ...BASE, MIN_BTC_SATS: '5', MAX_BTC_SATS: '4' })).toThrow(/MIN_BTC_SATS/);
  });
});
