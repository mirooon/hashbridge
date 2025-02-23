# Demo checklist

## Before going on stage
- [ ] Bot BTC balance ≥ 0.001 tBTC, Sui balance ≥ 50 SUI in coin objects (`curl https://hashbridge-bot.onrender.com/health` shows only coin objects as `suiMist`; the bot log warns at startup about SUI held as an address balance)
- [ ] UptimeRobot monitor is "Up" and nobody redeployed the bot since the last swap
- [ ] `MIN_CONF=0`, `BTC_LOCKTIME_BLOCKS=72`, `SUI_TIMEOUT_MS=3600000` on Render (and in local `apps/bot/.env`)
- [ ] `VITE_HTLC_PACKAGE_ID` equals `HTLC_PACKAGE_ID`
- [ ] HTLC package `0xe7de5f027f995a169f4bce706aa7dad4440a60cdcfcc4bee4d7219c0098d0061` is set as `HTLC_PACKAGE_ID` (bot) and `VITE_HTLC_PACKAGE_ID` (web)
- [ ] Signet wallet with ≥ 0.002 tBTC open on the demo laptop
- [ ] Sui wallet address copied (and the wallet extension installed for "Claim myself")
- [ ] mempool.space/signet and suiscan.xyz/testnet open in tabs
- [ ] https://mirooon.github.io/hashbridge/ loads and shows the rate (local `pnpm dev` as a fallback)

## End-to-end runs (to do)

1. Prepare the environment.
   1. Run `pnpm --filter @hashbridge/bot gen-keys` and put the keys into `apps/bot/.env`.
   2. Fund the bot's BTC address (at least 0.001 tBTC for fees) and the bot's Sui address (at least 50 SUI **in coin objects**; an address balance from the faucet cannot pay gas). If the bot logs `MIST held as address balance cannot pay gas`, split coins off it: `sui client ptb --split-coins gas "[500000000]" --assign c --transfer-objects "[c]" @<bot address>`.
   3. Run `./contracts/sui/scripts/publish.sh` and set `HTLC_PACKAGE_ID` and `VITE_HTLC_PACKAGE_ID`.
   4. Run `pnpm dev`.

   Expected: the bot log shows `hashbridge bot started` with its addresses. `curl localhost:8787/health` and `curl https://hashbridge-bot.onrender.com/health` return the balances and `tipHeight`.

2. Full swap.
   1. Open the hosted app at `https://mirooon.github.io/hashbridge/`, enter 0.001 BTC and the Sui address of your test wallet, and click "Start swap".
   2. Download the recovery file, then click "Continue".
   3. Pay the exact amount from any signet wallet to the address shown.

   Expected within about 1 minute: the timeline goes through all the steps, the "Swap complete" screen shows the SUI amount, the links open the transactions on mempool.space/signet and Suiscan, and the bot log shows `BTC claimed`.

3. Refund scenario.
   1. Locally (so production is not touched): stop the local bot, set `BTC_LOCKTIME_BLOCKS=2` and `SUI_TIMEOUT_MS=600000` (keep `SAFETY_BLOCKS=12`) in `apps/bot/.env`, run `pnpm dev`, and open `http://localhost:5173`.
   2. Start a new swap and pay. The bot rejects the deposit (`too close to the BTC locktime`) and the UI shows the refund screen.
   3. After about 2 blocks (about 20 minutes), enter your own signet address and click "Refund BTC".

   Expected: the refund transaction appears on mempool.space/signet and the funds return to the address you entered. Afterwards restore `BTC_LOCKTIME_BLOCKS=72` and `SUI_TIMEOUT_MS=3600000`.

## Recorded runs
| Date | Scenario | Deposit tx | SUI lock | SUI claim | BTC claim / refund | Result |
|---|---|---|---|---|---|---|
| | Full swap | | | | | |
| | Refund after rejection | | — | — | | |

Fill in the links after each run.

## Talking points
- Same SHA-256 hash on both chains; the secret that releases the SUI is the one the bot needs for the BTC.
- "Show HTLC script" on the deposit screen shows the Bitcoin side.
- The browser checks the Sui HTLC object itself before revealing the secret.
- With MIN_CONF=0 the demo trusts the mempool; production would wait for confirmations.
- Sui is accessed through gRPC and GraphQL because public fullnodes no longer serve JSON-RPC.
