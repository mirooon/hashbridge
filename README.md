# Hashbridge

Trustless BTC → SUI atomic swaps. Send Bitcoin on signet and receive SUI on testnet in about a minute. No custodian or bridge contract ever holds your funds.

**App:** https://mirooon.github.io/hashbridge/ · **Resolver API:** https://hashbridge-bot.onrender.com/health · **Contract:** [0xe7de…0061](https://suiscan.xyz/testnet/object/0xe7de5f027f995a169f4bce706aa7dad4440a60cdcfcc4bee4d7219c0098d0061)

## What it does

Hashbridge swaps coins between two chains built on different models: Bitcoin, where value lives in unspent outputs (UTXO), and Sui, where value lives in objects owned and moved by Move code. One SHA-256 hash locks the funds on both chains. The secret that releases your SUI is the same secret the resolver needs to take your BTC, so either both transfers happen or neither does.

The counterparty is an automated resolver bot. It quotes a price, locks SUI for you once your BTC deposit appears, and pays the gas for your claim. You need no Sui wallet and no SUI for gas: a Sui address is enough.

## A swap, step by step

1. **Enter the amount and your Sui address**, or connect a Sui wallet to fill it in. The form shows an indicative rate that refreshes every 30 seconds.
2. **Your browser creates the secrets.** It generates a 32-byte secret, its SHA-256 hash and a one-time Bitcoin refund key. Only the hash and the refund public key leave the browser.
3. **The bot quotes and the browser checks the quote.** The bot returns the price, its public key, a refund block height and the HTLC deposit address. The browser rebuilds the Bitcoin script on its own. If the bot's script or address differs from the local result by even a byte, the app refuses to show a deposit address.
4. **You download a recovery file.** It holds the secret, the refund key and every swap parameter. With it you can refund your BTC from any browser even if the bot disappears.
5. **You pay** from any signet wallet to the HTLC address. The screen shows a QR code (`bitcoin:` URI), copy buttons and a countdown for the quote.
6. **The bot locks SUI.** It sees your deposit in the mempool and locks the quoted amount in a Move HTLC with your address as the recipient.
7. **Your browser verifies the lock, then reveals the secret.** It reads the Sui object itself, through Sui's GraphQL service, and checks its type and package, the recipient, the hash, the amount and the deadline. Only then does it send the secret, and the bot submits the claim and pays the gas. SUI lands in your address, and the browser confirms on Sui that the HTLC object is gone instead of trusting the bot's status.
8. **The bot claims the BTC.** Your claim made the secret public on Sui. The bot reads it from the `Claimed` event and spends the Bitcoin HTLC.

A live timeline shows both chains side by side, with a link to mempool.space or Suiscan for every step.

## Why neither side can cheat

| What happens | Outcome |
|---|---|
| The bot never locks SUI | You refund your BTC with the refund key after the locktime (72 blocks, about 12 h). |
| The bot locks SUI and you never claim | After 1 hour the bot takes its SUI back; your BTC is refundable after the locktime. |
| You claim the SUI | The secret is now public. The bot has about 11 hours to claim the BTC before your refund opens. |
| The bot shows a fake or wrong HTLC | The browser's check fails and your secret is never revealed. |
| The bot sends your claim nowhere | If the claim is not on Sui 30 seconds after the secret was revealed, the app offers "Claim myself" from a connected wallet, before the Sui deadline. |

The Sui deadline always ends long before the Bitcoin locktime. The bot refuses to lock SUI if a deposit arrives too close to the locktime, so it can never be left holding a revealed secret it has no time to use.

## Under the hood

### Bitcoin HTLC (P2WSH)

```
OP_IF
    OP_SIZE 32 OP_EQUALVERIFY OP_SHA256 <hash> OP_EQUALVERIFY <bot pubkey>
OP_ELSE
    <locktime> OP_CHECKLOCKTIMEVERIFY OP_DROP <user refund pubkey>
OP_ENDIF
OP_CHECKSIG
```

- Claim (bot): witness `[signature, secret, 0x01, script]`.
- Refund (user): witness `[signature, <empty>, script]`, with `nLockTime` set to the locktime. The refund spends every output sent to the HTLC address, including accidental second deposits.

The deposit screen can show this script in readable form ("Show HTLC script").

### Sui HTLC (Move)

`hashbridge::htlc` holds the SUI in a shared `Htlc<T>` object with three entry points:

- `lock(coin, recipient, hash, refund_after_ms, clock)` creates the object and emits `Locked`.
- `claim(htlc, preimage, clock)` checks the deadline and `sha256(preimage) == hash`, pays the recipient and emits `Claimed` with the preimage. Anyone may submit the claim, but the money always goes to the recipient. That lets the bot pay the gas for you.
- `refund(htlc, clock)` returns the coins to the sender after the deadline.

Both chains require the secret to be exactly 32 bytes. Without that rule, a secret longer than 520 bytes would be accepted on Sui but could never be used in a Bitcoin script, and the bot would pay out SUI without being able to collect the BTC.

### Resolver bot

A single Node process with an HTTP API (Hono), a polling loop and a SQLite database (`node:sqlite`).

```
AWAITING_DEPOSIT → DEPOSIT_SEEN → SUI_LOCKED → SUI_CLAIMED → BTC_CLAIMED
       ↘ EXPIRED         ↘ REJECTED      ↘ SUI_REFUNDED
```

- **API:** `POST /swaps` (quote and HTLC), `GET /swaps/:id` (status and transaction digests; the web app builds the explorer links), `POST /swaps/:id/claim` (gasless claim), `GET /health` (balances, block height, rate and limits).
- **Quotes:** a fixed rate plus a spread, valid for 60 seconds. The browser refuses a quote below the rate it displayed. The locked amount is the quote scaled to what was actually deposited, up to the configured maximum. Late or too-small deposits are rejected and stay refundable.
- **Restart safety:** every Sui transaction is signed and stored before it is sent. After a restart the bot looks up the stored digest instead of signing again, so it never locks SUI twice. Signed BTC claims are also stored and re-broadcast byte for byte.
- **One transaction at a time:** all Sui submissions run through a single queue, so the API and the loop never race for the same gas coin.
- **Isolation:** one failing swap, for example an RPC timeout, never blocks the others; it is retried on the next cycle.

### Browser app

- Rebuilds the Bitcoin script and address before showing anything payable.
- Reads the Sui HTLC object itself, through Sui's GraphQL service, before revealing the secret. The object must come from the configured Hashbridge package, so the bot cannot substitute a lookalike. After the reveal it keeps reading the object: the swap counts as done only once the object is gone from Sui.
- Keeps each swap in local storage under `#/swap/<id>`, so a reload resumes where you left off. "Import recovery file" restores a swap in any browser.
- Offers refunds when a swap is rejected, expires or stalls, and builds and signs the refund transaction locally with your refund key.

## Architecture

```
            ┌───────────────────────────────┐
            │  Browser (Vite + React)       │  secrets, refund key, script checks,
            │  mirooon.github.io/hashbridge │  Sui object verification, refunds
            └──────┬─────────┬──────────────┘
       quotes,     │         │  direct reads
       status,     │         ├──────────────► Sui GraphQL (testnet)
       claim relay │         └──────────────► Esplora (mempool.space/signet)
            ┌──────▼──────────────────┐
            │  Resolver bot (Node)    │  state machine, SQLite,
            │  hashbridge-bot.onrender│  Sui + BTC signing
            └──────┬─────────┬────────┘
                   │         │
         Move HTLC ▼         ▼ P2WSH HTLC
            Sui testnet    Bitcoin signet
```

## Repository layout

```
contracts/sui/      Move package hashbridge::htlc, tests, publish script
packages/core/      shared TypeScript: HTLC script, BTC claim/refund txs,
                    Esplora client, pricing, keys, shared types
apps/bot/           resolver: API, engine steps, Sui adapter, SQLite repo
apps/web/           React app: form, recovery, deposit, timeline, refund
docs/               design spec, implementation plan, deployment, demo checklist
render.yaml         Render blueprint for the bot
```

The browser and the bot import the same `packages/core` code, so both compute the same HTLC address.

## Tech stack

- **Bitcoin:** bitcoinjs-lib, ecpair, @bitcoinerlab/secp256k1 (pure JS, runs in the browser), @noble/hashes
- **Sui:** Move 2024, @mysten/sui, @mysten/dapp-kit
- **Bot:** Node 22, Hono, `node:sqlite`, tsx
- **Web:** React 18, Vite, Tailwind CSS, qrcode.react
- **Tooling:** TypeScript (strict), pnpm workspaces, Vitest, `sui move test`

## Run it locally

Prerequisites: Node ≥ 22.13, pnpm 9 (`npm install -g pnpm@9.15.9`), Sui CLI ≥ 1.45 (`brew install sui`) with a funded testnet address (`sui client faucet`).

```bash
pnpm install
pnpm --filter @hashbridge/bot gen-keys      # prints BTC_WIF, SUI_PRIVATE_KEY and the addresses to fund
./contracts/sui/scripts/publish.sh          # prints the package id
cp apps/bot/.env.example apps/bot/.env      # fill in keys and HTLC_PACKAGE_ID
cp apps/web/.env.example apps/web/.env      # set VITE_HTLC_PACKAGE_ID
pnpm dev                                    # bot on :8787, web on :5173
```

Fund the bot's signet address from a signet faucet such as https://signetfaucet.com, and its Sui address from https://faucet.sui.io. The bot needs at least 50 SUI **in coin objects**: it pays gas and locks only from coin objects, and counts only them as liquidity. The faucet may credit an address balance instead, which the bot cannot spend (it logs a warning at startup). Turn it into a coin object with the Sui CLI:

```bash
sui client ptb --split-coins gas "[500000000]" --assign c --transfer-objects "[c]" @<bot address>
```

### Environment variables

| Bot (`apps/bot/.env`) | Default | Meaning |
|---|---|---|
| `BTC_WIF`, `SUI_PRIVATE_KEY` | — | Bot keys (`gen-keys`) |
| `HTLC_PACKAGE_ID` | — | Published Move package |
| `RATE` | — | SUI per 1 BTC |
| `SPREAD_BPS` | 50 | Fee in basis points |
| `QUOTE_TTL_S` | 60 | Quote validity |
| `MIN_CONF` | 0 | Confirmations before locking SUI |
| `BTC_LOCKTIME_BLOCKS` | 72 | Refund delay on Bitcoin |
| `SUI_TIMEOUT_MS` | 3600000 | Claim window on Sui |
| `SAFETY_BLOCKS` | 12 | Minimum blocks left before the locktime when SUI is locked; at least 1, and `SUI_TIMEOUT_MS` + 30 min must fit in `SAFETY_BLOCKS` × 10 min |
| `MIN_BTC_SATS`, `MAX_BTC_SATS` | 10000, 1000000 | Swap size limits |
| `GAS_RESERVE_MIST` | 200000000 | SUI kept back for gas |
| `ESPLORA_URL`, `SUI_RPC_URL` | public signet / testnet endpoints | Chain access. The bot derives its Sui GraphQL URL from `SUI_RPC_URL`, so it must be a `fullnode.<network>.sui.io` host |
| `PORT`, `POLL_INTERVAL_MS`, `DB_PATH` | 8787, 3000, `./hashbridge.db` | Process settings |

| Web (`apps/web/.env`) | Default | Meaning |
|---|---|---|
| `VITE_API_URL` | `http://localhost:8787` | Bot URL |
| `VITE_HTLC_PACKAGE_ID` | — | Package the browser accepts HTLC objects from |
| `VITE_ESPLORA_URL` | `https://mempool.space/signet/api` | Esplora endpoint for deposits, refunds and block height |
| `VITE_SUI_GRAPHQL_URL` | `https://graphql.testnet.sui.io/graphql` | Sui GraphQL endpoint the browser reads the HTLC from |

## Tests

```bash
pnpm test         # core, bot and web unit tests
pnpm typecheck
pnpm test:move    # Move contract tests
```

The bot's engine runs against in-memory fakes of both chains, including a full deposit → lock → claim → BTC claim swap, a refund path and crash-restart cases. The Bitcoin code is checked against BIP173 vectors and verifies every signature it produces.

## Deployment

Everything runs on free tiers with free domains:

| Part | Host | Address |
|---|---|---|
| Web | GitHub Pages (free, deployed by .github/workflows/pages.yml) | https://mirooon.github.io/hashbridge/ |
| Web (alternative) | Vercel (apps/web/vercel.json) | connect in the dashboard |
| Resolver bot | Render free web service (`render.yaml`) | https://hashbridge-bot.onrender.com |
| Keep-alive | UptimeRobot free monitor on `/health` every 5 min | — |
| Contract | Sui testnet | `0xe7de5f027f995a169f4bce706aa7dad4440a60cdcfcc4bee4d7219c0098d0061` |

See `docs/deploy.md` for the details and the free-tier limits.

## Limitations

- Testnets only: Bitcoin signet and Sui testnet.
- One direction (BTC → SUI) and one resolver with a fixed rate.
- With `MIN_CONF=0` the bot trusts the mempool, which keeps the demo fast but lets a user replace the deposit (RBF) after the bot has locked SUI. Use `MIN_CONF=1` or more outside a demo.
- On Render's free plan a restart or redeploy wipes the bot's database, so the bot is never redeployed while a swap is in progress.
- Republish the package for contract changes; do not use `sui client upgrade` — event types keep the original package id. The bot finds a new HTLC by its `Locked` event; if a lock lands without one, the bot records the transaction, never signs a second lock for that swap and logs that manual action is needed.
