#!/usr/bin/env bash
set -euo pipefail

echo "[1/4] Installing workspace dependencies..."
npm install

echo "[2/4] Verifying Wrangler installation..."
if ! npx wrangler --version >/dev/null 2>&1; then
  echo "Wrangler is not available. Install/login first, then re-run bootstrap." >&2
  exit 1
fi

echo "[3/4] Verifying Wrangler authentication..."
if ! npx wrangler whoami >/dev/null 2>&1; then
  echo "Wrangler auth check failed. Run: npx wrangler login" >&2
  exit 1
fi

echo "[4/4] Linking pincer CLI commands globally..."
npm run install:cli

cat <<'OUT'

Bootstrap complete.

If Wrangler warns about missing OAuth scopes, refresh login:
  npx wrangler login

Next steps:
  1) pincer-admin setup
  2) pincer-agent connect <worker-host> --code <CODE>
  3) pincer-agent adapters propose --file ./manifest.json
OUT
