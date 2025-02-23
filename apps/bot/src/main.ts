import 'dotenv/config';
import { serve } from '@hono/node-server';
import { EsploraClient } from '@hashbridge/core/esplora';
import { btcKeyFromWif, p2wpkhAddress } from '@hashbridge/core/keys';
import { createApi } from './api';
import { loadConfig } from './config';
import { startLoop } from './engine/runner';
import { openSwapRepo } from './repo';
import { addressBalanceWarning, createSuiChain } from './sui-chain';
import type { EngineDeps, Logger } from './types';

const log: Logger = (msg, extra) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));

const config = loadConfig();
const sui = createSuiChain({ rpcUrl: config.suiRpcUrl, privateKey: config.suiPrivateKey, packageId: config.htlcPackageId });
const botKey = btcKeyFromWif(config.btcWif);
const deps: EngineDeps = {
  repo: openSwapRepo(config.dbPath),
  btc: new EsploraClient(config.esploraUrl),
  sui,
  config,
  botKey,
  now: () => Date.now(),
  log,
};

/** SUI held as an address balance shows up in getBalance but cannot pay gas or locks; say so at startup. */
async function warnAboutAddressBalance(): Promise<void> {
  try {
    const [coinMist, totalMist] = await Promise.all([sui.balanceMist(), sui.totalBalanceMist()]);
    const warning = addressBalanceWarning(coinMist, totalMist, sui.address());
    if (warning) log(`WARNING: ${warning}`, { coinMist, totalMist });
  } catch (err) {
    log('could not check the SUI balance at startup', { error: err instanceof Error ? err.message : String(err) });
  }
}

serve({ fetch: createApi(deps).fetch, port: config.port });
log('hashbridge bot started', { port: config.port, suiAddress: sui.address(), btcAddress: p2wpkhAddress(botKey.publicKey) });
void warnAboutAddressBalance();
void startLoop(deps);
