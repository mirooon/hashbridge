# Deployment

| Part | Host | URL / config |
|---|---|---|
| Web | GitHub Pages (free) | https://mirooon.github.io/hashbridge/ — deployed by `.github/workflows/pages.yml` on every push to `main` |
| Web (alternative) | Vercel (free, `*.vercel.app`) | `apps/web/vercel.json` — connect the repo in the Vercel dashboard with Root Directory `apps/web` and set the same three `VITE_*` variables as in the workflow (`VITE_API_URL`, `VITE_HTLC_PACKAGE_ID`, `VITE_ESPLORA_URL`) |
| Resolver bot | Render free web service (`*.onrender.com`) | `render.yaml` blueprint; target URL https://hashbridge-bot.onrender.com; set the secrets `BTC_WIF` and `SUI_PRIVATE_KEY` in the dashboard |
| Keep-alive | UptimeRobot free monitor, every 5 min | `GET /health` on the bot URL |
| Contract | Sui testnet | package `0xe7de5f027f995a169f4bce706aa7dad4440a60cdcfcc4bee4d7219c0098d0061`, publish tx `AFxoZXaxGsFzKeEKqJ8US2o9bvcwscU5kFkZ7Zetijhw` |

## Web on GitHub Pages

The workflow builds `apps/web` with `vite build --base /hashbridge/` because Pages serves the site under `/hashbridge/`. The three `VITE_*` values are set in the workflow's build step. The app uses hash routing (`#/swap/<id>`), so no SPA 404 fallback is needed.

A repo owner must enable Pages once (Settings → Pages → Source: GitHub Actions). The workflow can also be started by hand from the Actions tab (`workflow_dispatch`).

## Web on Vercel (alternative)

Vercel serves the site from the domain root, so it does not need the `--base` flag; `apps/web/vercel.json` runs the plain `pnpm build`. In the Vercel dashboard: New Project, pick the repo, set Root Directory to `apps/web`, add the three `VITE_*` variables for Production, deploy. If the project name is taken, add a free `*.vercel.app` subdomain under Settings → Domains.

## Resolver bot on Render

1. Render → New → Blueprint → pick the repo; Render reads `render.yaml`.
2. Enter the secrets `BTC_WIF` and `SUI_PRIVATE_KEY` (the same values as in the local `apps/bot/.env`). `HTLC_PACKAGE_ID` is public and already set in the blueprint.
3. Deploy. If the build fails on `corepack enable`, change `buildCommand` to `npm install -g pnpm@9.15.9 && pnpm install --frozen-lockfile`.
4. Check it: `curl -fsS https://hashbridge-bot.onrender.com/health` returns JSON with `botPubkey`, `suiAddress`, `tipHeight` and the balances. If the name is taken, Render adds a suffix to the URL; then update `VITE_API_URL` in the workflow and the README.

## Keep-alive monitor

Create a free UptimeRobot account → Add New Monitor → HTTP(s), URL `https://hashbridge-bot.onrender.com/health`, interval 5 minutes.

## Sui endpoints

Public Sui fullnodes no longer serve JSON-RPC, so the bot talks gRPC (`https://fullnode.testnet.sui.io:443`) and GraphQL (`https://graphql.testnet.sui.io/graphql`).

## Redeploying

- Web: every push to `main` redeploys on GitHub Pages (and on Vercel, if it is connected).
- Bot: manual deploy in the Render dashboard (`autoDeploy: false`).

## Free-tier limits

- Render keeps the filesystem only until the next restart or deploy. The SQLite file in `/tmp` goes with it, so never redeploy the bot while a swap is in progress. Users can still refund their BTC after the locktime with the recovery file; SUI the bot already locked stays locked until someone refunds it by hand.
- Render sleeps after 15 minutes without inbound traffic; the UptimeRobot monitor prevents that. If the monitor stops, the first request after a pause takes up to a minute.
- Render's free plan gives 750 instance hours per month, enough for one service running all month.
