import type { BotConfig } from './types';

type Env = Record<string, string | undefined>;

const REQUIRED = ['BTC_WIF', 'SUI_PRIVATE_KEY', 'HTLC_PACKAGE_ID', 'RATE'] as const;
const BLOCK_MS = 600_000;
/** Time the bot keeps for claiming the BTC after the Sui deadline (finding the secret, broadcasting, confirming). */
export const BTC_CLAIM_MARGIN_MS = 30 * 60_000;

export function loadConfig(env: Env = process.env): BotConfig {
  const missing = REQUIRED.filter((key) => !env[key]);
  if (missing.length > 0) throw new Error(`Missing required env vars: ${missing.join(', ')}`);

  const num = (key: string, fallback: number, integer = true): number => {
    const raw = env[key];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || (integer && !Number.isInteger(n))) {
      throw new Error(`${key} must be ${integer ? 'an integer' : 'a number'}, got "${raw}"`);
    }
    return n;
  };

  const packageId = env.HTLC_PACKAGE_ID!;
  if (!/^0x[0-9a-fA-F]{64}$/.test(packageId)) throw new Error('HTLC_PACKAGE_ID must be 0x followed by 64 hex characters');

  const config: BotConfig = {
    port: num('PORT', 8787),
    btcWif: env.BTC_WIF!,
    suiPrivateKey: env.SUI_PRIVATE_KEY!,
    htlcPackageId: packageId.toLowerCase(),
    suiRpcUrl: env.SUI_RPC_URL || 'https://fullnode.testnet.sui.io:443',
    esploraUrl: env.ESPLORA_URL || 'https://mempool.space/signet/api',
    rate: num('RATE', 0, false),
    spreadBps: num('SPREAD_BPS', 50),
    quoteTtlS: num('QUOTE_TTL_S', 60),
    minConf: num('MIN_CONF', 0),
    btcLocktimeBlocks: num('BTC_LOCKTIME_BLOCKS', 72),
    suiTimeoutMs: num('SUI_TIMEOUT_MS', 3_600_000),
    safetyBlocks: num('SAFETY_BLOCKS', 12),
    minBtcSats: num('MIN_BTC_SATS', 10_000),
    maxBtcSats: num('MAX_BTC_SATS', 1_000_000),
    gasReserveMist: BigInt(num('GAS_RESERVE_MIST', 200_000_000)),
    pollIntervalMs: num('POLL_INTERVAL_MS', 3_000),
    dbPath: env.DB_PATH || './hashbridge.db',
  };

  if (config.rate <= 0) throw new Error('RATE must be positive');
  if (config.minBtcSats > config.maxBtcSats) throw new Error('MIN_BTC_SATS must not exceed MAX_BTC_SATS');
  if (config.safetyBlocks < 1) throw new Error('SAFETY_BLOCKS must be at least 1');
  if (config.suiTimeoutMs >= config.btcLocktimeBlocks * BLOCK_MS) {
    throw new Error('SUI_TIMEOUT_MS must be shorter than BTC_LOCKTIME_BLOCKS × 10 min, otherwise the bot can lose the BTC');
  }
  // The lock guard (tip + SAFETY_BLOCKS < locktime) only promises SAFETY_BLOCKS blocks before the BTC refund opens:
  // the Sui deadline plus the BTC-claim margin must fit in them, or a user claiming late could leave no time to take the BTC.
  if (config.suiTimeoutMs + BTC_CLAIM_MARGIN_MS > config.safetyBlocks * BLOCK_MS) {
    throw new Error(
      'SUI_TIMEOUT_MS + 30 min must fit in SAFETY_BLOCKS × 10 min (blocks left before the BTC locktime when SUI is locked), otherwise the bot can lose the BTC',
    );
  }
  return config;
}
