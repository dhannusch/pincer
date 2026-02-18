# pincer-admin

`pincer-admin` is the setup, diagnostics, and adapter-management CLI.

## Fast Path

Run from repository root:

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
- `PINCER_WORKER_NAME` (used for secret updates)
- `PINCER_ADMIN_PASSPHRASE`

To avoid entering the passphrase repeatedly, export both vars in your shell profile:

```bash
export PINCER_WORKER_URL="https://<your-worker>.workers.dev"
export PINCER_WORKER_NAME="<your-worker-name>"
export PINCER_ADMIN_PASSPHRASE="<your-admin-passphrase>"
```

### `setup`

What it does:
- Checks Wrangler availability and auth.
- Creates local `apps/pincer-worker/wrangler.toml` from `wrangler.toml.example` when missing.
- Prompts for Worker name and admin passphrase.
- Generates runtime key + HMAC secret.
- Writes KV config keys (`meta:version`, `runtime:active`, `adapter_registry:index`).
- Writes Worker secrets and deploys the Worker.
- Generates one-time pairing code for `pincer-agent connect`.
- Saves worker URL default to `~/.pincer/admin.json` for later admin commands.
- Saves worker directory default so setup/secret commands can be run from other directories.
- Saves runtime pairing material locally so additional pairing codes can be generated without rotating credentials.

After setup, run the printed `pincer-agent connect ... --code ...` command on the OpenClaw host machine.
Pairing codes are one-time use and should come from the most recent `setup` or `pairing generate` run.

### `pairing generate`

Generates a new one-time pairing code without rotating runtime credentials.

### `credentials rotate`

Rotates runtime key + runtime HMAC secret, writes new runtime metadata to KV, updates Worker HMAC secret, and prints a new one-time pairing command. Existing runtime credentials are invalidated immediately.

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
- Writes provided secret values to Worker secrets, then applies.
- Warns when source is an external URL.

### `adapters validate --file <path> [--json]`

Validates an adapter manifest locally without proposing or applying it.

### `adapters disable <adapter-id>`

Disables adapter execution without deleting manifest snapshots.

### `adapters enable <adapter-id>`

Re-enables a disabled adapter without re-applying a manifest.

### `adapters secret set <binding> [--worker-name <name>]`

Updates a single Worker secret binding (useful for key rotation).

## Troubleshooting

- `missing_required_secrets` on apply
  - Set missing bindings via `pincer-admin adapters secret set <binding>` and re-run apply.
- `401`/`403` on admin routes
  - Confirm admin passphrase.
- Wrangler auth failures
  - Run `wrangler login` and retry.
