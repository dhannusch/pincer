# pincer-admin

`pincer-admin` is the setup, diagnostics, and adapter-management CLI for [Pincer](https://github.com/dhannusch/pincer).

## Installation

```bash
npm install -g @pincerclaw/admin
```

## Quick Start

```bash
pincer-admin setup
pincer-admin doctor
```

## From Source

If running from the cloned repository:

```bash
./scripts/install-cli.sh
pincer-admin setup
pincer-admin doctor
```

## Local (No Global Link)

```bash
npm run pincer-admin -- <command>
```

If your worker directory is outside the default repo path, set:

```bash
export PINCER_WORKER_DIR=/path/to/pincer-worker
```

## Commands

Admin commands read these defaults automatically when set:
- `PINCER_WORKER_URL`
- `PINCER_WORKER_NAME`
- `PINCER_ADMIN_USERNAME`
- `PINCER_ADMIN_PASSWORD`

To avoid entering credentials repeatedly, export these vars in your shell profile:

```bash
export PINCER_WORKER_URL="https://<your-worker>.workers.dev"
export PINCER_WORKER_NAME="<your-worker-name>"
export PINCER_ADMIN_USERNAME="admin"
export PINCER_ADMIN_PASSWORD="<your-admin-password>"
```

### `setup`

What it does:
- Checks Wrangler availability and auth.
- Creates local `apps/pincer-worker/wrangler.toml` from `wrangler.toml.example` when missing.
- Prompts for Worker name.
- Generates runtime key + runtime HMAC secret + bootstrap token + vault KEK.
- Writes KV config keys (`meta:version`, `runtime:active`, `adapter_registry:index`).
- Writes Worker secrets and deploys the Worker.
- Prints bootstrap URL/token instructions for first admin creation in `/admin/bootstrap`.
- Saves worker URL default to `~/.pincer/admin.json` for later admin commands.

After setup:
1. Open `/admin/bootstrap` and create the admin account.
2. Use `pincer-admin pairing generate` (or UI) to produce a one-time connect code.

### `pairing generate`

Generates a new one-time pairing code via authenticated admin API.

### `credentials rotate`

Rotates runtime key + runtime HMAC secret via authenticated admin API and prints a new one-time pairing command. Existing runtime credentials are invalidated immediately.

### `doctor [--json]`

What it does:
- Calls `/v1/health`.
- Calls `/v1/admin/doctor` with admin auth.
- Reports runtime + registry + secret readiness.

### `proposals list [--json]`

Lists pending adapter proposals.

### `proposals inspect <proposal-id> [--json]`

Shows proposal metadata and full manifest for review.

### `proposals approve <proposal-id> [--force]`

Approves and applies a pending proposal by proposal ID.

### `proposals reject <proposal-id> [--reason "..."]`

Rejects a pending proposal, removes it from the queue, and records the rejection in audit history.

### `audit list [--limit <n>] [--since <iso>] [--json]`

Lists proposal audit events (`proposal_submitted`, `proposal_approved`, `proposal_rejected`).

### `adapters list [--json]`

Lists active/disabled adapters from registry.

### `adapters apply ... [--force]`

Apply from exactly one source:

```bash
pincer-admin adapters apply --file ./manifest.json
pincer-admin adapters apply --url https://example.com/manifest.json
```

Behavior:
- Validates manifest before apply.
- Collects required secret inputs before confirmation.
- Shows a summary + confirmation prompt unless `--force` is used.
- Writes provided secret values through `/v1/admin/secrets/:binding` (write-only vault API), then applies.
- Warns when source is an external URL.

### `adapters validate --file <path> [--json]`

Validates an adapter manifest locally without proposing or applying it.

### `adapters disable <adapter-id>`

Disables adapter execution without deleting manifest snapshots.

### `adapters enable <adapter-id>`

Re-enables a disabled adapter without re-applying a manifest.

### `adapters secret set <binding>`

Updates a single secret binding through the write-only admin secrets API.

## Troubleshooting

- `missing_required_secrets` on apply
  - Set missing bindings via `pincer-admin adapters secret set <binding>` and re-run apply.
- `401`/`403` on admin routes
  - Confirm `PINCER_ADMIN_USERNAME`/`PINCER_ADMIN_PASSWORD` (or interactive credentials) and active admin session policies.
- Wrangler auth failures
  - Run `wrangler login` and retry.
