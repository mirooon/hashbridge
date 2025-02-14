#!/usr/bin/env bash
# Publishes the HTLC package to Sui testnet with the active `sui client` address and prints the package id.
set -euo pipefail
cd "$(dirname "$0")/.."
sui client switch --env testnet >/dev/null
sui client publish --gas-budget 200000000 --json | node -e '
  let s = "";
  process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const out = JSON.parse(s);
    const pub = (out.objectChanges || []).find((c) => c.type === "published");
    if (!pub) { console.error("publish failed:", out.effects?.status); process.exit(1); }
    console.log(pub.packageId);
  });
'
