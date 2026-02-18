# Pincer

[![CI](https://github.com/dhannusch/pincer/actions/workflows/ci.yml/badge.svg)](https://github.com/dhannusch/pincer/actions/workflows/ci.yml)
[![Secret Scan](https://github.com/dhannusch/pincer/actions/workflows/secrets.yml/badge.svg)](https://github.com/dhannusch/pincer/actions/workflows/secrets.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue?logo=typescript)](https://www.typescriptlang.org/)
[![Runs on Cloudflare Workers](https://img.shields.io/badge/Runs%20on-Cloudflare%20Workers-F38020?logo=cloudflare)](https://workers.cloudflare.com/)
[![Node.js LTS](https://img.shields.io/badge/Node.js-LTS-339933?logo=node.js)](https://nodejs.org/)
[![npm @pincerclaw/admin](https://img.shields.io/npm/v/@pincerclaw/admin?label=%40pincerclaw%2Fadmin)](https://www.npmjs.com/package/@pincerclaw/admin)
[![npm @pincerclaw/agent](https://img.shields.io/npm/v/@pincerclaw/agent?label=%40pincerclaw%2Fagent)](https://www.npmjs.com/package/@pincerclaw/agent)

Pincer is a dynamic adapter boundary for OpenClaw, built on Cloudflare Workers.

It lets OpenClaw agents call external APIs without storing provider API keys on the local machine. Adapters are manifest-driven, so agents can propose new integrations and humans can review/apply them.

## Table of Contents

- [Why This Exists](#why-this-exists)
- [Why Cloudflare Workers](#why-cloudflare-workers)
- [How Components Are Distributed](#how-components-are-distributed)
- [Prerequisites](#prerequisites)
- [Quickstart](#quickstart)
- [OpenClaw Prompt Examples](#openclaw-prompt-examples)
- [Adapter Lifecycle](#adapter-lifecycle)
- [Cloudflare Config Safety](#cloudflare-config-safety)
- [Command Surface](#command-surface)
- [Support Matrix](#support-matrix)
- [Troubleshooting](#troubleshooting)
- [Repository Layout](#repository-layout)
- [Development](#development)
- [Open Source Release Prep](#open-source-release-prep)
- [Docs](#docs)
- [Community](#community)

## Why This Exists

OpenClaw agents are excellent at creating integration logic quickly. The hard part is keeping credentials and network permissions safe.

Pincer separates concerns:

- OpenClaw agent: creates/updates adapter manifests and submits proposals.
- Human admin: approves and applies adapters, rotates secrets, disables risky adapters.
- Worker boundary: enforces runtime auth, manifest validation, and outbound host controls.

## Why Cloudflare Workers

Pincer is designed to run on Cloudflare Workers, including free-plan setups for early usage.

Benefits:

- No server management.
- Global edge execution.
- Worker Secrets for API credentials.
- Workers KV for runtime and adapter registry state.

## How Components Are Distributed

Pincer is a monorepo.

Published to npm:

- `@pincerclaw/admin` (CLI: `pincer-admin`)
- `@pincerclaw/agent` (CLI: `pincer-agent`)
- `@pincerclaw/shared-types`

Source-distributed in repo:

- `apps/pincer-worker` (Cloudflare Worker deployment target)

## Prerequisites

- Cloudflare account.
- Node.js LTS (20.x+ recommended).
- npm.
- Wrangler authenticated in your Cloudflare account.
- OpenClaw host machine for `pincer-agent`.

Wrangler check:

```bash
npx wrangler --version
npx wrangler login
npx wrangler whoami
```

## Quickstart

### 1. Install the CLIs

On your **admin machine**:

```bash
npm install -g @pincerclaw/admin
```

On your **OpenClaw host machine**:

```bash
npm install -g @pincerclaw/agent
```

### 2. Get the worker source

The Cloudflare Worker is deployed from source. Clone the repo on your admin machine:

```bash
git clone https://github.com/dhannusch/pincer.git
cd pincer
```

### 3. Verify Wrangler auth

```bash
npx wrangler whoami
```

If not logged in:

```bash
npx wrangler login
```

### 4. Run setup

```bash
pincer-admin setup
```

This bootstraps Cloudflare resources, deploys the worker, and prints a one-time pairing command. Run that command on your OpenClaw host machine.

### 5. Pair the agent

On your **OpenClaw host machine**:

```bash
pincer-agent connect pincer-worker.example.workers.dev --code ABCD-1234
```

This writes credentials to `~/.pincer/credentials.json` and installs the OpenClaw skill at `~/.openclaw/skills/pincer/SKILL.md`.

### 6. Propose an adapter

```bash
pincer-agent adapters propose --file ./manifest.json
```

For a ready local test manifest:

```bash
pincer-agent adapters propose --file ./examples/httpbin.manifest.json
```

### 7. Review and apply

```bash
pincer-admin proposals list
pincer-admin proposals inspect <proposal-id>
pincer-admin proposals approve <proposal-id>
```

### 8. Call an adapter

```bash
pincer-agent call <adapter_id> <action_name> --input '{"key":"value"}'
```

## OpenClaw Prompt Examples

You can prompt OpenClaw with instructions like:

- "Create a Pincer adapter manifest for Stripe and save it as `stripe.manifest.json`."
- "Submit this manifest as a Pincer proposal."
- "Update the Stripe adapter to revision 2 and add an endpoint for invoices."

The installed skill teaches the exact commands and update flow.

## Adapter Lifecycle

### 1. Propose

```bash
pincer-agent adapters propose --file ./manifest.json
```

### 2. Review

```bash
pincer-admin proposals list
pincer-admin proposals inspect <proposal-id>
```

### 3. Apply

Pick exactly one source:

```bash
pincer-admin proposals approve <proposal-id>
pincer-admin adapters apply --file ./manifest.json
pincer-admin adapters apply --url https://example.com/manifest.json
```

`apply` validates manifests and prompts for confirmation by default (`--force` skips confirmation).

Validate manifests offline before proposing/applying:

```bash
pincer-agent adapters validate --file ./manifest.json
pincer-admin adapters validate --file ./manifest.json
```

### 4. Update adapter behavior

Re-apply with:

- same `id`
- higher `revision`

Use this for API spec changes, endpoint additions/removals, and limits/auth updates.

### 5. Rotate API keys

```bash
pincer-admin adapters secret set <SECRET_BINDING>
```

No manifest revision bump is required for secret rotation alone.

### 6. Rotate runtime credentials (incident response)

```bash
pincer-admin credentials rotate
```

This rotates runtime key + HMAC material, prints a new pairing command, and immediately invalidates previously issued runtime credentials.

## Cloudflare Config Safety

Pincer uses template-based Wrangler config:

- tracked template: `apps/pincer-worker/wrangler.toml.example`
- local generated config: `apps/pincer-worker/wrangler.toml`

The local config is gitignored so account-specific IDs are not committed.

If your worker directory is not `apps/pincer-worker`, set:

```bash
export PINCER_WORKER_DIR=/path/to/pincer-worker
```

## Command Surface

- `pincer-admin setup`
- `pincer-admin pairing generate`
- `pincer-admin credentials rotate`
- `pincer-admin doctor [--json]`
- `pincer-admin proposals list [--json]`
- `pincer-admin proposals inspect <proposal-id> [--json]`
- `pincer-admin proposals approve <proposal-id> [--force]`
- `pincer-admin proposals reject <proposal-id> [--reason "..."]`
- `pincer-admin audit list [--limit <n>] [--since <iso>] [--json]`
- `pincer-admin adapters list [--json]`
- `pincer-admin adapters apply (--file <path> | --url <url>) [--force]`
- `pincer-admin adapters validate --file <path> [--json]`
- `pincer-admin adapters disable <adapter-id>`
- `pincer-admin adapters enable <adapter-id>`
- `pincer-admin adapters secret set <binding> [--worker-name <name>]`
- `pincer-agent connect <worker-host> --code <CODE>`
- `pincer-agent call <adapter> <action> [--input '<json>' | --input-file <path>]`
- `pincer-agent adapters list [--json]`
- `pincer-agent adapters validate --file <path> [--json]`
- `pincer-agent adapters propose (--manifest '<json>' | --file <path>)`

## Support Matrix

Official initial support:

- Node.js LTS
- Linux and macOS

Windows is best-effort until explicitly promoted.

## Troubleshooting

- `Request failed (401/403)`
  - Run `pincer-admin doctor`.
  - Confirm runtime key/HMAC and admin passphrase.
- `missing_required_secrets` during apply
  - Set missing bindings via `pincer-admin adapters secret set <binding>`.
- `No credentials found`
  - Run `pincer-agent connect <worker-host> --code <CODE>`.
- `invalid_or_expired_code` during connect
  - Use the latest code printed by `pincer-admin setup` or `pincer-admin pairing generate`.
  - Pairing codes are one-time use.
  - Run the connect command on your OpenClaw host machine.

## Repository Layout

- `apps/pincer-worker` - Cloudflare Worker runtime boundary
- `apps/pincer-admin` - admin CLI
- `apps/pincer-agent` - agent CLI
- `packages/pincer-shared-types` - shared auth/manifest types
- `docs/` - architecture, security, deployment, release docs

## Development

```bash
npm run typecheck
npm test
```

## Open Source Release Prep

Run guardrails before pushing:

```bash
npm run oss:guard
npm run release:check
```

Run secret scans:

```bash
npm run secrets:scan            # working tree
npm run secrets:scan:history    # git history (requires gitleaks + git repo)
```

`secrets:scan*` requires local `gitleaks` installation.

Run clean-machine smoke prep:

```bash
npm run smoke:clean
```

## Docs

- Architecture: `docs/architecture.md`
- Security model: `docs/security.md`
- OpenClaw integration: `docs/openclaw-integration.md`
- Deployment details: `docs/deployment.md`
- Release process: `docs/release.md`
- OSS release checklist: `docs/open-source-checklist.md`
- Project roadmap: `docs/roadmap.md`
- Changelog: `CHANGELOG.md`

## Community

- Contribution guide: `CONTRIBUTING.md`
- Code of conduct: `CODE_OF_CONDUCT.md`
- Security policy: `SECURITY.md`
- Support policy: `SUPPORT.md`
- License: `LICENSE`

---

Built by [Dennis Hannusch](https://dennishannusch.com) · [@dennishannusch](https://x.com/dennishannusch) · [pincer.run](https://pincer.run)
