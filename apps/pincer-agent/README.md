# pincer-agent

`pincer-agent` pairs with a deployed Pincer Worker, sends signed runtime calls, and submits adapter proposals. Part of [Pincer](https://github.com/dhannusch/pincer).

## Installation

```bash
npm install -g @pincerclaw/agent
```

## Quick Start

On the admin machine:

```bash
pincer-admin setup
```

On the OpenClaw host:

```bash
pincer-agent connect pincer-worker.example.workers.dev --code ABCD-1234
```

Submit a proposal:

```bash
pincer-agent adapters propose --file ./manifest.json
```

Call an activated adapter:

```bash
pincer-agent call <adapter_id> <action_name> --input '{"key":"value"}'
```

Or load input from a file:

```bash
pincer-agent call <adapter_id> <action_name> --input-file ./payload.json
```

## Local (No Global Link)

```bash
npm run pincer-agent -- connect <worker-host> --code <CODE>
npm run pincer-agent -- adapters propose --file ./manifest.json
npm run pincer-agent -- adapters validate --file ./manifest.json
npm run pincer-agent -- adapters list
npm run pincer-agent -- call <adapter> <action> --input '<json>'
```

## Credential Resolution

Credentials are resolved in this order:

1. Environment variables (preferred when all three are set):
   - `PINCER_WORKER_URL`
   - `PINCER_RUNTIME_KEY` (format: `<keyId>.<keySecret>`)
   - `PINCER_HMAC_SECRET`
2. Credentials file at `~/.pincer/credentials.json`

## Commands

### `connect <worker-host> --code <CODE>`

- Exchanges pairing code via `POST /v1/connect`.
- Saves credentials.
- Verifies `/v1/health`.
- Installs OpenClaw skill at `~/.openclaw/skills/pincer/SKILL.md`.

### `call <adapter> <action> [--input '<json>' | --input-file <path>]`

- Validates input is a JSON object.
- Signs request with runtime key + HMAC headers.
- Sends `POST /v1/adapter/<adapter>/<action>`.

### `adapters list [--json]`

- Sends runtime-authenticated request to `GET /v1/adapters`.
- Returns enabled adapter IDs and action names.

### `adapters validate --file <path> [--json]`

- Validates a manifest file locally.
- Does not require runtime credentials.

### `adapters propose (--manifest '<json>' | --file <path>)`

- Validates manifest locally.
- Sends runtime-authenticated proposal to `POST /v1/adapters/proposals`.

## Troubleshooting

- `No credentials found`
  - Run `pincer-agent connect` or set `PINCER_*` env vars.
- `Request failed (401/403)`
  - Verify runtime key/HMAC.
  - Run `pincer-admin doctor`.
- `invalid_manifest`
  - Validate required fields and schema constraints before proposing.
