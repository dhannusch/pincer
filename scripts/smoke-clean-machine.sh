#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "[1/5] Running OSS guard checks..."
npm run oss:guard

echo "[2/5] Typechecking..."
npm run typecheck

echo "[3/5] Running tests..."
npm test

echo "[4/5] Verifying CLI entrypoints..."
node --import tsx apps/pincer-admin/src/cli.ts --help >/dev/null
node --import tsx apps/pincer-agent/src/cli.ts --help >/dev/null

echo "[5/5] Printing manual cloud smoke flow..."
cat <<'OUT'
Local smoke checks passed.

Run this manual cloud flow on a clean machine with Wrangler auth:
  1) npm run bootstrap
  2) pincer-admin setup
  3) pincer-agent connect <worker-host> --code <CODE>
  4) pincer-agent adapters propose --file ./manifest.json
  5) pincer-admin proposals list
  6) pincer-admin proposals approve <proposal-id>
  7) pincer-agent call <adapter_id> <action_name> --input '{"ping":"pong"}'
OUT
