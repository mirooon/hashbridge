import { bcs } from '@mysten/sui/bcs';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { SuiGraphQLClient } from '@mysten/sui/graphql';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction, TransactionDataBuilder, type TransactionPlugin } from '@mysten/sui/transactions';
import { fromBase64, normalizeStructTag, normalizeSuiAddress, normalizeSuiObjectId, toBase64 } from '@mysten/sui/utils';
import { bytesToHex, hexToBytes } from '@hashbridge/core/secret';
import type { ClaimEventInfo, LockParams, SignedTx, SuiChain, SuiTxKind, SuiTxResult } from './types';

export interface SuiChainOptions {
  /** gRPC-web base URL of a fullnode, e.g. https://fullnode.testnet.sui.io:443 */
  rpcUrl: string;
  privateKey: string;
  packageId: string;
  /** Sui GraphQL endpoint. Derived from `rpcUrl` for the public testnet/devnet/mainnet fullnodes when omitted. */
  graphqlUrl?: string;
}

const SUI_TYPE = '0x2::sui::SUI';
const SUI_COIN_TYPE = `0x2::coin::Coin<${SUI_TYPE}>`;
/** sui.rpc.v2.Owner.OwnerKind.SHARED (the proto enums are not exported by @mysten/sui). */
const OWNER_KIND_SHARED = 3;
const NETWORKS = ['testnet', 'devnet', 'mainnet'] as const;

/**
 * Fields read from a gRPC `ExecutedTransaction`. Paths are relative to ExecutedTransaction for both
 * ExecuteTransaction and GetTransaction (checked against the testnet fullnode; `transaction.*` paths are rejected).
 */
const TX_READ_MASK = ['digest', 'effects.status', 'events.events.event_type', 'events.events.contents'];
/** SimulateTransaction masks are relative to its response, hence the `transaction.` prefix. */
const SIMULATE_READ_MASK = ['transaction.effects.status', 'transaction.effects.gas_used'];

// Gas estimation mirrors the SDK's JSON-RPC resolver: dry run with a mock gas coin and the max budget.
const MAX_GAS = 50_000_000_000n;
const GAS_SAFE_OVERHEAD = 1_000n;

/** Deadline of every single network call, so one stalled request cannot block the serialized Sui queue. */
const CALL_TIMEOUT_MS = 30_000;
const FINALITY_TIMEOUT_MS = 60_000;
const FINALITY_POLL_MS = 1_000;
const MAX_CLAIM_PAGES = 20;

/** Coin fields read from ListOwnedObjects; `balance` is Object field 101 (set for `0x2::coin::Coin<T>` objects). */
export const COIN_READ_MASK = ['object_id', 'version', 'digest', 'balance'];
/** Sui accepts at most 256 gas payment objects per transaction. */
export const MAX_GAS_COINS = 255;
const COIN_PAGE_SIZE = 1_000;
const MAX_COIN_PAGES = 10;

// Move event layouts from contracts/sui/sources/htlc.move (an `ID` is serialized like an address).
const LockedEvent = bcs.struct('Locked', {
  htlc_id: bcs.Address,
  sender: bcs.Address,
  recipient: bcs.Address,
  amount: bcs.u64(),
  hash: bcs.vector(bcs.u8()),
  refund_after_ms: bcs.u64(),
});
const ClaimedEvent = bcs.struct('Claimed', { htlc_id: bcs.Address, preimage: bcs.vector(bcs.u8()) });

function networkOf(url: string): (typeof NETWORKS)[number] | undefined {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return undefined;
  }
  return NETWORKS.find((n) => host.split(/[.-]/).includes(n));
}

export function graphqlUrlFor(rpcUrl: string): string {
  const network = networkOf(rpcUrl);
  if (!network) {
    throw new Error(`Cannot derive the Sui GraphQL URL from rpcUrl "${rpcUrl}" (no testnet/devnet/mainnet host); pass graphqlUrl`);
  }
  return `https://graphql.${network}.sui.io/graphql`;
}

export function bytesFromMoveJson(value: unknown): Uint8Array {
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  if (typeof value === 'string') return fromBase64(value);
  throw new Error('unexpected vector<u8> encoding in Move JSON');
}

function isEventType(type: string | undefined | null, expected: string): boolean {
  if (!type) return false;
  try {
    return normalizeStructTag(type) === normalizeStructTag(expected);
  } catch {
    return false;
  }
}

/** The subset of a gRPC `ExecutedTransaction` selected by TX_READ_MASK. */
export interface GrpcExecutedTx {
  digest?: string;
  effects?: { status?: { success?: boolean; error?: { description?: string } } };
  events?: { events: ReadonlyArray<{ eventType?: string; contents?: { value?: Uint8Array } }> };
}

export function toTxResult(tx: GrpcExecutedTx | undefined, packageId: string): SuiTxResult {
  const status = tx?.effects?.status;
  // A missing status means the outcome is unknown; reporting it as a failure could make the caller act wrongly.
  if (!tx?.digest || !status) throw new Error('gRPC response is missing the transaction digest or effects status');
  const lockedType = `${normalizeSuiAddress(packageId)}::htlc::Locked`;
  const locked = tx.events?.events.find((e) => isEventType(e.eventType, lockedType));
  const success = status.success === true;
  return {
    digest: tx.digest,
    success,
    error: success ? null : (status.error?.description ?? 'transaction failed'),
    htlcObjectId: locked?.contents?.value ? LockedEvent.parse(locked.contents.value).htlc_id : null,
  };
}

export function findClaimInEvents(
  events: ReadonlyArray<{ id: { txDigest: string }; parsedJson: unknown }>,
  htlcObjectId: string,
): ClaimEventInfo | null {
  const wanted = normalizeSuiObjectId(htlcObjectId);
  for (const event of events) {
    const parsed = event.parsedJson as { htlc_id?: string; preimage?: unknown } | null;
    // Only Claimed events carry a preimage; Locked/Refunded events of the same HTLC are skipped.
    if (typeof parsed?.htlc_id === 'string' && normalizeSuiObjectId(parsed.htlc_id) === wanted && parsed.preimage !== undefined) {
      return { digest: event.id.txDigest, preimage: bytesToHex(bytesFromMoveJson(parsed.preimage)) };
    }
  }
  return null;
}

/** The claim of `htlcObjectId` in a fully fetched gRPC transaction, decoding `Claimed` events from BCS. */
export function findClaimInTx(tx: GrpcExecutedTx, htlcObjectId: string, packageId: string): ClaimEventInfo | null {
  const claimedType = `${normalizeSuiAddress(packageId)}::htlc::Claimed`;
  const events = (tx.events?.events ?? []).flatMap((e) =>
    isEventType(e.eventType, claimedType) && e.contents?.value
      ? [{ id: { txDigest: tx.digest ?? '' }, parsedJson: ClaimedEvent.parse(e.contents.value) }]
      : [],
  );
  return findClaimInEvents(events, htlcObjectId);
}

/**
 * Newest-first page of the transactions that touched an HTLC object, with their events as JSON. A transaction's events
 * are paginated too; `pageInfo.hasNextPage` there tells that GraphQL cut them off.
 */
const CLAIM_QUERY = `
  query HtlcTransactions($object: SuiAddress!, $before: String) {
    transactions(last: 50, before: $before, filter: { affectedObject: $object }) {
      pageInfo { hasPreviousPage startCursor }
      nodes {
        digest
        effects { events(first: 50) { pageInfo { hasNextPage } nodes { contents { type { repr } json } } } }
      }
    }
  }
`;

/** Result shape of CLAIM_QUERY. */
export interface ClaimPage {
  transactions: {
    pageInfo: { hasPreviousPage: boolean; startCursor: string | null };
    nodes: ReadonlyArray<{
      digest: string;
      effects: {
        events: { pageInfo: { hasNextPage: boolean }; nodes: ReadonlyArray<{ contents: { type: { repr: string } | null; json: unknown } | null }> };
      } | null;
    }>;
  } | null;
}

/**
 * Finds the claim of `htlcObjectId` in one page. `needsFullFetch` lists the transactions whose events GraphQL did not
 * return completely, so the absence of a claim in them proves nothing; `nextCursor` is the next (older) page, if any.
 */
export function parseClaimPage(
  page: ClaimPage,
  htlcObjectId: string,
  packageId: string,
): { claim: ClaimEventInfo | null; needsFullFetch: string[]; nextCursor: string | null } {
  const claimedType = `${normalizeSuiAddress(packageId)}::htlc::Claimed`;
  const nodes = page.transactions?.nodes ?? [];
  const events = nodes.flatMap((tx) =>
    (tx.effects?.events.nodes ?? [])
      .filter((e) => isEventType(e.contents?.type?.repr, claimedType))
      .map((e) => ({ id: { txDigest: tx.digest }, parsedJson: e.contents?.json })),
  );
  const needsFullFetch = nodes.filter((tx) => !tx.effects || tx.effects.events.pageInfo.hasNextPage).map((tx) => tx.digest);
  const info = page.transactions?.pageInfo;
  return { claim: findClaimInEvents(events, htlcObjectId), needsFullFetch, nextCursor: info?.hasPreviousPage ? info.startCursor : null };
}

/** grpc-web hands over the grpc-message trailer percent-encoded; decode it so messages can be read and matched. */
export function normalizeGrpcError(err: unknown): unknown {
  if (err instanceof Error && err.name === 'RpcError') {
    try {
      err.message = decodeURIComponent(err.message);
    } catch {
      // not percent-encoded; keep as is
    }
  }
  return err;
}

/**
 * True only for the fullnode's "transaction not found" answer to GetTransaction. Timeouts, rate limits and an HTTP 404
 * (which grpc-web also reports as NOT_FOUND, but with the bare status text) are not.
 */
export function isTxNotFoundError(err: unknown): boolean {
  if (!(err instanceof Error) || err.name !== 'RpcError' || (err as { code?: unknown }).code !== 'NOT_FOUND') return false;
  const message = (normalizeGrpcError(err) as Error).message;
  return /^transaction \S+ not found$/i.test(message.trim());
}

export function gasBudgetFromDryRun(
  gasUsed: { computationCost?: bigint | string; storageCost?: bigint | string; storageRebate?: bigint | string },
  gasPrice: bigint,
): bigint {
  const base = BigInt(gasUsed.computationCost ?? 0) + GAS_SAFE_OVERHEAD * gasPrice;
  const budget = base + BigInt(gasUsed.storageCost ?? 0) - BigInt(gasUsed.storageRebate ?? 0);
  return budget > base ? budget : base;
}

async function grpc<T>(call: PromiseLike<T>): Promise<T> {
  try {
    return await call;
  } catch (err) {
    throw normalizeGrpcError(err);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The subset of a gRPC `Object` selected by COIN_READ_MASK. */
export interface CoinObject {
  objectId?: string;
  version?: bigint;
  digest?: string;
  balance?: bigint;
}

export interface GasCoin {
  objectId: string;
  version: string;
  digest: string;
  balance: bigint;
}

/** Reads every page of a ListOwnedObjects listing, up to `maxPages` (a cut-off listing only under-counts the SUI). */
export async function listAllCoinPages(
  fetchPage: (pageToken: Uint8Array | undefined) => Promise<{ objects: CoinObject[]; nextPageToken?: Uint8Array }>,
  maxPages = MAX_COIN_PAGES,
): Promise<CoinObject[]> {
  const all: CoinObject[] = [];
  let token: Uint8Array | undefined;
  for (let i = 0; i < maxPages; i++) {
    const page = await fetchPage(token);
    all.push(...page.objects);
    if (!page.nextPageToken?.length) break;
    token = page.nextPageToken;
  }
  return all;
}

/**
 * The SUI coin objects one transaction can spend: the largest MAX_GAS_COINS. They are both the gas payment of every tx
 * the bot signs and, summed, its liquidity, so the bot never counts SUI it cannot spend (such as an address balance).
 */
export function spendableCoins(objects: readonly CoinObject[]): GasCoin[] {
  return objects
    .filter((c) => c.objectId && c.version !== undefined && c.digest)
    .map((c) => ({ objectId: c.objectId!, version: String(c.version), digest: c.digest!, balance: c.balance ?? 0n }))
    .sort((a, b) => (a.balance === b.balance ? 0 : a.balance > b.balance ? -1 : 1))
    .slice(0, MAX_GAS_COINS);
}

export function sumBalances(coins: readonly GasCoin[]): bigint {
  return coins.reduce((sum, c) => sum + c.balance, 0n);
}

const SPLIT_COIN_COMMAND = (address: string) =>
  `sui client ptb --split-coins gas "[500000000]" --assign c --transfer-objects "[c]" @${address}`;

/** Startup warning when the address holds more SUI (getBalance) than its spendable coin objects. */
export function addressBalanceWarning(coinMist: bigint, totalMist: bigint, address: string): string | null {
  if (totalMist <= coinMist) return null;
  return `${totalMist - coinMist} MIST held as address balance cannot pay gas; split coins with ${SPLIT_COIN_COMMAND(address)}`;
}

/**
 * gRPC call options with a deadline. With grpc-web, `timeout` only sends the grpc-timeout header to the server; the abort
 * signal is what cuts a stalled connection on our side.
 */
const deadline = () => ({ timeout: CALL_TIMEOUT_MS, abort: AbortSignal.timeout(CALL_TIMEOUT_MS) });

function noGasCoinsError(address: string): Error {
  return new Error(
    `No SUI coin objects to pay gas with at ${address}. The key may hold SUI only as an address balance, which ` +
      `@mysten/sui 1.45.2 cannot spend for gas. Fix: split a coin object off it, e.g. ${SPLIT_COIN_COMMAND(address)}`,
  );
}

export interface BotSuiChain extends SuiChain {
  /** All SUI of the address (coin objects plus address balance), for the startup warning only. */
  totalBalanceMist(): Promise<bigint>;
}

export function createSuiChain(opts: SuiChainOptions): BotSuiChain {
  const graphqlUrl = opts.graphqlUrl ?? graphqlUrlFor(opts.rpcUrl);
  const network = networkOf(opts.rpcUrl) ?? 'unknown';
  const client = new SuiGrpcClient({ network, baseUrl: opts.rpcUrl });
  const graphql = new SuiGraphQLClient({ url: graphqlUrl, network });
  const { secretKey } = decodeSuiPrivateKey(opts.privateKey);
  const keypair = Ed25519Keypair.fromSecretKey(secretKey);
  const address = keypair.toSuiAddress();
  const pkg = normalizeSuiAddress(opts.packageId);
  const target = (fn: string) => `${pkg}::htlc::${fn}`;

  /**
   * The gRPC client in @mysten/sui 1.45 cannot resolve transactions ("Transaction resolution is not supported with the
   * GRPC client"), so gas is filled in by this build plugin before the SDK's resolver runs; inputs are passed resolved.
   * Raw service calls are used instead of `client.core` because only they accept per-call deadlines.
   */
  const resolveGas: TransactionPlugin = async (data, _options, next) => {
    if (!data.gasConfig.price) {
      const { response } = await grpc(client.ledgerService.getEpoch({ readMask: { paths: ['reference_gas_price'] } }, deadline()));
      const price = response.epoch?.referenceGasPrice;
      if (price === undefined) throw new Error('Sui fullnode returned no reference gas price');
      data.gasConfig.price = String(price);
    }
    if (!data.gasConfig.budget) {
      const probe = data.build({ overrides: { gasData: { budget: String(MAX_GAS), payment: [] } } });
      const { response } = await grpc(
        client.transactionExecutionService.simulateTransaction(
          { transaction: { bcs: { value: probe } }, readMask: { paths: SIMULATE_READ_MASK } },
          deadline(),
        ),
      );
      const effects = response.transaction?.effects;
      if (!effects?.status?.success || !effects.gasUsed) {
        const reason = effects?.status?.error?.description ?? 'no effects';
        throw new Error(`Dry run failed, could not automatically determine a budget: ${reason}`);
      }
      data.gasConfig.budget = String(gasBudgetFromDryRun(effects.gasUsed, BigInt(data.gasConfig.price)));
    }
    if (!data.gasConfig.payment) {
      const coins = await listSpendableCoins();
      if (coins.length === 0) throw noGasCoinsError(address);
      data.gasConfig.payment = coins.map(({ objectId, version, digest }) => ({ objectId, version, digest }));
    }
    await next();
  };

  async function listSpendableCoins(): Promise<GasCoin[]> {
    const objects = await listAllCoinPages(async (pageToken) => {
      const { response } = await grpc(
        client.stateService.listOwnedObjects(
          { owner: address, objectType: SUI_COIN_TYPE, pageSize: COIN_PAGE_SIZE, pageToken, readMask: { paths: COIN_READ_MASK } },
          deadline(),
        ),
      );
      return response;
    });
    return spendableCoins(objects);
  }

  async function sign(kind: SuiTxKind, tx: Transaction): Promise<SignedTx> {
    tx.setSender(address);
    tx.addBuildPlugin(resolveGas);
    const bytes = await tx.build({ client });
    const { signature } = await keypair.signTransaction(bytes);
    return { kind, digest: TransactionDataBuilder.getDigestFromBytes(bytes), bytes: toBase64(bytes), signature };
  }

  /** The Htlc is a shared object taken by value, so it is passed as a mutable shared input. */
  async function htlcInput(tx: Transaction, htlcObjectId: string) {
    const { response } = await grpc(
      client.ledgerService.getObject({ objectId: htlcObjectId, readMask: { paths: ['object_id', 'owner'] } }, deadline()),
    );
    const owner = response.object?.owner;
    // A shared owner with an address is a consensus-address owner, not a plain shared object.
    if (owner?.kind !== OWNER_KIND_SHARED || owner.address || owner.version === undefined) {
      throw new Error(`HTLC ${htlcObjectId} is not a shared object (owner kind: ${owner?.kind ?? 'unknown'})`);
    }
    return tx.sharedObjectRef({ objectId: htlcObjectId, initialSharedVersion: String(owner.version), mutable: true });
  }

  /** The executed tx with all its events, or null only if the fullnode definitely does not know the digest. */
  async function fetchTx(digest: string): Promise<GrpcExecutedTx | null> {
    try {
      const { response } = await grpc(client.ledgerService.getTransaction({ digest, readMask: { paths: TX_READ_MASK } }, deadline()));
      if (!response.transaction) throw new Error(`Sui fullnode returned no transaction for ${digest}`);
      return response.transaction;
    } catch (err) {
      if (isTxNotFoundError(err)) return null;
      throw err;
    }
  }

  async function lookup(digest: string): Promise<SuiTxResult | null> {
    const tx = await fetchTx(digest);
    return tx ? toTxResult(tx, pkg) : null;
  }

  /**
   * Waits until the fullnode serves the executed tx, so later reads see its effects. The core API's waitForTransaction
   * is not used: in SDK 1.45.2 its getTransaction fails to parse current gRPC responses and it would retry until timeout.
   */
  async function waitUntilVisible(digest: string): Promise<void> {
    const deadline = Date.now() + FINALITY_TIMEOUT_MS;
    while (!(await lookup(digest))) {
      if (Date.now() >= deadline) throw new Error(`Sui tx ${digest} executed but not visible after ${FINALITY_TIMEOUT_MS} ms`);
      await sleep(FINALITY_POLL_MS);
    }
  }

  return {
    address: () => address,

    // Only coin objects can pay for a lock (an address balance cannot be spent by this SDK), so only they count.
    async balanceMist() {
      return sumBalances(await listSpendableCoins());
    },

    async totalBalanceMist() {
      const { response } = await grpc(client.stateService.getBalance({ owner: address, coinType: SUI_TYPE }, deadline()));
      return response.balance?.balance ?? 0n;
    },

    signLock(p: LockParams) {
      const tx = new Transaction();
      const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(p.amountMist)]);
      tx.moveCall({
        target: target('lock'),
        typeArguments: [SUI_TYPE],
        arguments: [coin!, tx.pure.address(p.recipient), tx.pure.vector('u8', Array.from(hexToBytes(p.hash))), tx.pure.u64(p.deadlineMs), tx.object.clock()],
      });
      return sign('lock', tx);
    },

    async signClaim(htlcObjectId: string, preimage: string) {
      const tx = new Transaction();
      tx.moveCall({
        target: target('claim'),
        typeArguments: [SUI_TYPE],
        arguments: [await htlcInput(tx, htlcObjectId), tx.pure.vector('u8', Array.from(hexToBytes(preimage))), tx.object.clock()],
      });
      return sign('claim', tx);
    },

    async signRefund(htlcObjectId: string) {
      const tx = new Transaction();
      tx.moveCall({ target: target('refund'), typeArguments: [SUI_TYPE], arguments: [await htlcInput(tx, htlcObjectId), tx.object.clock()] });
      return sign('refund', tx);
    },

    async execute(tx: SignedTx) {
      const { response } = await grpc(
        client.transactionExecutionService.executeTransaction(
          {
            transaction: { bcs: { value: fromBase64(tx.bytes) } },
            signatures: [{ bcs: { value: fromBase64(tx.signature) }, signature: { oneofKind: undefined } }],
            readMask: { paths: TX_READ_MASK },
          },
          deadline(),
        ),
      );
      const result = toTxResult(response.transaction, pkg);
      await waitUntilVisible(result.digest);
      return result;
    },

    lookup,

    async findClaim(htlcObjectId: string) {
      // Claim deletes the shared Htlc, so its tx is the newest one touching the object: walk pages newest first.
      // Hitting the page cap therefore means the newest 1000 txs hold no claim, i.e. there is none.
      let before: string | null = null;
      for (let i = 0; i < MAX_CLAIM_PAGES; i++) {
        const { data, errors } = await graphql.query<ClaimPage>({
          query: CLAIM_QUERY,
          variables: { object: normalizeSuiObjectId(htlcObjectId), before },
          signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        });
        if (errors?.length) throw new Error(`Sui GraphQL error: ${errors.map((e) => e.message).join('; ')}`);
        if (!data) throw new Error('Sui GraphQL returned no data');
        const { claim, needsFullFetch, nextCursor } = parseClaimPage(data, htlcObjectId, pkg);
        if (claim) return claim;
        // GraphQL cut these txs' events off (e.g. 50+ junk events before Claimed): gRPC returns all events of a tx.
        for (const digest of needsFullFetch) {
          const full = await fetchTx(digest);
          if (!full) throw new Error(`Sui tx ${digest} touched HTLC ${htlcObjectId} but the fullnode does not know it; cannot tell whether it claimed`);
          const found = findClaimInTx(full, htlcObjectId, pkg);
          if (found) return found;
        }
        if (!nextCursor) return null;
        before = nextCursor;
      }
      return null;
    },
  };
}
