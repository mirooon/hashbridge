import 'dotenv/config';
import { serve } from '@hono/node-server';
import { EsploraClient } from '@hashbridge/core/esplora';
import { btcKeyFromWif, p2wpkhAddress } from '@hashbridge/core/keys';
import { createApi } from './api';
import { loadConfig } from './config';
import { startLoop } from './engine/runner';
import { openSwapRepo } from './repo';
import { createSuiChain } from './sui-chain';
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

serve({ fetch: createApi(deps).fetch, port: config.port });
log('hashbridge bot started', { port: config.port, suiAddress: sui.address(), btcAddress: p2wpkhAddress(botKey.publicKey) });
void startLoop(deps);
