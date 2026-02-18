#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

failures=0
in_git_repo=0

fail() {
  echo "ERROR: $1" >&2
  failures=1
}

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  in_git_repo=1
fi

is_tracked_file() {
  local file_path="$1"
  git ls-files --error-unmatch "$file_path" >/dev/null 2>&1
}

is_tracked_prefix() {
  local prefix="$1"
  [ -n "$(git ls-files -- "$prefix")" ]
}

if [ ! -f "apps/pincer-worker/wrangler.toml.example" ]; then
  fail "Missing apps/pincer-worker/wrangler.toml.example."
else
  if ! grep -q 'replace-with-your-kv-namespace-id' apps/pincer-worker/wrangler.toml.example; then
    fail "wrangler.toml.example must keep the placeholder KV namespace id."
  fi

  if grep -qE 'id[[:space:]]*=[[:space:]]*"[a-f0-9]{32}"' apps/pincer-worker/wrangler.toml.example; then
    fail "wrangler.toml.example contains a concrete KV namespace id."
  fi
fi

if [ "$in_git_repo" -eq 1 ]; then
  if is_tracked_file "apps/pincer-worker/wrangler.toml"; then
    fail "apps/pincer-worker/wrangler.toml must not be tracked."
  fi

  if is_tracked_prefix ".wrangler-logs"; then
    fail ".wrangler-logs must not be tracked."
  fi

  if is_tracked_prefix ".claude"; then
    fail ".claude must not be tracked."
  fi

  if is_tracked_prefix ".pincer"; then
    fail ".pincer must not be tracked."
  fi
else
  if [ -f "apps/pincer-worker/wrangler.toml" ]; then
    fail "Local apps/pincer-worker/wrangler.toml should not be present for OSS/release checks."
  fi

  if [ -d ".wrangler-logs" ]; then
    fail "Local .wrangler-logs directory should be removed before release."
  fi
fi

if grep -rn --exclude-dir=node_modules --exclude-dir=.git \
  -E 'api\.cloudflare\.com/client/v4/accounts/[a-f0-9]{32}' . >/dev/null 2>&1; then
  echo "Found hardcoded Cloudflare account ids in tracked source/docs:" >&2
  grep -rn --exclude-dir=node_modules --exclude-dir=.git \
    -E 'api\.cloudflare\.com/client/v4/accounts/[a-f0-9]{32}' . >&2
  failures=1
fi

if [ "$failures" -ne 0 ]; then
  exit 1
fi

echo "OSS guard checks passed."
