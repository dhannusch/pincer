#!/usr/bin/env bash
set -euo pipefail

echo "[1/2] Installing workspace dependencies..."
npm install

echo "[2/2] Linking pincer CLI commands globally..."
npm run install:cli

cat <<'EOF'
Done.

You can now run:
  pincer-admin setup                              # deploy Worker, get pairing code
  pincer-agent connect <host> --code <CODE>      # pair with deployed Worker
  pincer-agent adapters propose --file ./manifest.json
  pincer-admin proposals list
  pincer-admin proposals approve <proposal-id>
EOF
