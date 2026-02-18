#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

MODE="${1:-working-tree}"
CONFIG_ARGS=()

if [ -f ".gitleaks.toml" ]; then
  CONFIG_ARGS=(--config ".gitleaks.toml")
fi

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "gitleaks is not installed." >&2
  echo "Install: https://github.com/gitleaks/gitleaks#installing" >&2
  exit 1
fi

case "$MODE" in
  working-tree)
    gitleaks detect --source . --no-git --redact "${CONFIG_ARGS[@]}"
    ;;
  history)
    if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      echo "History scan requires a git repository." >&2
      exit 1
    fi
    gitleaks git --redact --verbose "${CONFIG_ARGS[@]}"
    ;;
  *)
    echo "Usage: ./scripts/secrets-scan.sh [working-tree|history]" >&2
    exit 1
    ;;
esac
