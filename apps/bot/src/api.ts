import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { buildWitnessScript, htlcAddress } from '@hashbridge/core/htlc-script';
import { isCompressedPubkeyHex, p2wpkhAddress } from '@hashbridge/core/keys';
import { quoteMist } from '@hashbridge/core/pricing';
import { bytesToHex, hexToBytes, secretMatchesHash } from '@hashbridge/core/secret';
import type { CreateSwapRequest, CreateSwapResponse, HealthResponse, SwapView } from '@hashbridge/core/types';
import { submitOnce } from './engine/pending';
import type { BotConfig, EngineDeps, SwapRecord } from './types';

export const CLAIM_MARGIN_MS = 60_000;

const VIEW_KEYS = [
  'swapId', 'status', 'createdAt', 'hash', 'htlcAddress', 'witnessScript', 'locktime', 'btcSats', 'suiRecipient',
  'suiAmount', 'quoteExpiresAt', 'depositTxid', 'depositSats', 'htlcObjectId', 'suiDeadlineMs', 'lockDigest',
  'claimDigest', 'btcClaimTxid', 'refundDigest', 'rejectReason',
] as const satisfies readonly (keyof SwapView)[];

export function toView(record: SwapRecord): SwapView {
  const view: Record<string, unknown> = {};
  for (const key of VIEW_KEYS) view[key] = record[key];
  return view as unknown as SwapView;
}

export function validateCreate(body: unknown, config: BotConfig): string | null {
  if (!body || typeof body !== 'object') return 'body must be a JSON object';
  const b = body as Record<string, unknown>;
  if (typeof b.hash !== 'string' || !/^[0-9a-f]{64}$/.test(b.hash)) return 'hash must be 32 bytes of lowercase hex';
  if (typeof b.refundPubkey !== 'string' || !isCompressedPubkeyHex(b.refundPubkey)) return 'refundPubkey must be a compressed public key in hex';
  if (typeof b.suiRecipient !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(b.suiRecipient)) return 'suiRecipient must be a 0x-prefixed 32-byte Sui address';
  if (typeof b.btcSats !== 'number' || !Number.isInteger(b.btcSats)) return 'btcSats must be an integer';
  if (b.btcSats < config.minBtcSats || b.btcSats > config.maxBtcSats) return `btcSats must be between ${config.minBtcSats} and ${config.maxBtcSats}`;
  return null;
}

export function createApi(deps: EngineDeps): Hono {
  const app = new Hono();
  app.use('*', cors());
  app.onError((err, c) => {
    deps.log('api error', { error: err.message });
    return c.json({ error: 'internal error' }, 500);
  });

  app.get('/health', async (c) => {
    const [utxos, suiMist, tipHeight] = await Promise.all([
      deps.btc.addressUtxos(p2wpkhAddress(deps.botKey.publicKey)),
      deps.sui.balanceMist(),
      deps.btc.tipHeight(),
    ]);
    const res: HealthResponse = {
      botPubkey: bytesToHex(deps.botKey.publicKey),
      suiAddress: deps.sui.address(),
      btcSats: utxos.reduce((sum, u) => sum + u.value, 0),
      suiMist: suiMist.toString(),
      tipHeight,
      rate: deps.config.rate,
      spreadBps: deps.config.spreadBps,
      minBtcSats: deps.config.minBtcSats,
      maxBtcSats: deps.config.maxBtcSats,
    };
    return c.json(res);
  });

  app.post('/swaps', async (c) => {
    const body = await c.req.json().catch(() => null);
    const invalid = validateCreate(body, deps.config);
    if (invalid) return c.json({ error: invalid }, 400);
    const req = body as CreateSwapRequest;
    if (deps.repo.findByHash(req.hash)) return c.json({ error: 'hash already used by another swap' }, 409);

    const suiAmount = quoteMist(req.btcSats, deps.config.rate, deps.config.spreadBps);
    const balance = await deps.sui.balanceMist();
    if (balance < suiAmount + deps.config.gasReserveMist) return c.json({ error: 'bot cannot cover this amount right now' }, 503);

    const tip = await deps.btc.tipHeight();
    const locktime = tip + deps.config.btcLocktimeBlocks;
    const witnessScript = bytesToHex(
      buildWitnessScript({ hash: hexToBytes(req.hash), claimPubkey: deps.botKey.publicKey, refundPubkey: hexToBytes(req.refundPubkey), locktime }),
    );
    const address = htlcAddress(hexToBytes(witnessScript));
    const now = deps.now();
    const record: SwapRecord = {
      swapId: randomUUID(), status: 'AWAITING_DEPOSIT', createdAt: now, hash: req.hash, htlcAddress: address, witnessScript,
      locktime, btcSats: req.btcSats, suiRecipient: req.suiRecipient.toLowerCase(), suiAmount: suiAmount.toString(),
      quoteExpiresAt: now + deps.config.quoteTtlS * 1000, depositTxid: null, depositSats: null, htlcObjectId: null,
      suiDeadlineMs: null, lockDigest: null, claimDigest: null, btcClaimTxid: null, refundDigest: null, rejectReason: null,
      refundPubkey: req.refundPubkey, depositVout: null, depositFirstSeenAt: null, preimage: null, btcClaimTxHex: null,
      pendingTx: null,
    };
    // The awaits above let a concurrent request with the same hash pass the early check; re-check with no await before insert.
    if (deps.repo.findByHash(req.hash)) return c.json({ error: 'hash already used by another swap' }, 409);
    deps.repo.insert(record);
    deps.log('swap created', { swapId: record.swapId, btcSats: req.btcSats });

    const res: CreateSwapResponse = {
      swapId: record.swapId, botPubkey: bytesToHex(deps.botKey.publicKey), locktime, htlcAddress: address, witnessScript,
      suiAmount: record.suiAmount, quoteExpiresAt: record.quoteExpiresAt,
    };
    return c.json(res, 201);
  });

  app.get('/swaps/:id', (c) => {
    const swap = deps.repo.get(c.req.param('id'));
    return swap ? c.json(toView(swap)) : c.json({ error: 'swap not found' }, 404);
  });

  app.post('/swaps/:id/claim', async (c) => {
    const swap = deps.repo.get(c.req.param('id'));
    if (!swap) return c.json({ error: 'swap not found' }, 404);
    const body = (await c.req.json().catch(() => null)) as { preimage?: unknown } | null;
    const preimage = typeof body?.preimage === 'string' ? body.preimage.toLowerCase() : '';
    if (!secretMatchesHash(preimage, swap.hash)) return c.json({ error: 'preimage does not match the swap hash' }, 400);

    if ((swap.status === 'SUI_CLAIMED' || swap.status === 'BTC_CLAIMED') && swap.claimDigest) {
      return c.json({ digest: swap.claimDigest });
    }
    if (swap.status !== 'SUI_LOCKED' || !swap.htlcObjectId || swap.suiDeadlineMs === null) {
      return c.json({ error: 'swap is not ready to be claimed' }, 409);
    }
    if (deps.now() >= swap.suiDeadlineMs - CLAIM_MARGIN_MS) {
      return c.json({ error: 'too close to the Sui deadline, claim it yourself' }, 409);
    }

    const withPreimage = deps.repo.update(swap.swapId, { preimage });
    const result = await submitOnce(withPreimage, deps, 'claim', () => deps.sui.signClaim(swap.htlcObjectId!, preimage));
    if (!result.success) {
      // A racing claim may have landed while this one was in flight; report that claim instead of a failure.
      const latest = deps.repo.get(swap.swapId);
      if (latest && (latest.status === 'SUI_CLAIMED' || latest.status === 'BTC_CLAIMED') && latest.claimDigest) {
        return c.json({ digest: latest.claimDigest });
      }
      return c.json({ error: `claim failed: ${result.error}` }, 502);
    }
    deps.repo.update(swap.swapId, { status: 'SUI_CLAIMED', claimDigest: result.digest });
    deps.log('claim relayed', { swapId: swap.swapId, digest: result.digest });
    return c.json({ digest: result.digest });
  });

  return app;
}
