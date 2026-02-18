# OpenClaw Integration

Use `pincer-agent` to make secure adapter calls and submit adapter proposals without exposing API keys on the local host.

## Setup

On the admin machine:

```bash
pincer-admin setup
```

On the OpenClaw host:

```bash
pincer-agent connect pincer-worker.example.workers.dev --code ABCD-1234
```

Use the exact command printed by `pincer-admin setup`. Pairing codes are one-time use.

This saves credentials to `~/.pincer/credentials.json` and installs the OpenClaw skill at `~/.openclaw/skills/pincer/SKILL.md`.

## Credential Resolution

The agent resolves credentials in order:

1. Environment variables (if all three core vars are set):
   - `PINCER_WORKER_URL`
   - `PINCER_RUNTIME_KEY`
   - `PINCER_HMAC_SECRET`
2. Credentials file at `~/.pincer/credentials.json`

## Runtime Call Example

```bash
pincer-agent call <adapter_id> <action_name> --input '{"key":"value"}'
```

```bash
pincer-agent call <adapter_id> <action_name> --input-file ./payload.json
```

## Runtime Adapter Discovery

```bash
pincer-agent adapters list
```

## Proposal Example

```bash
pincer-agent adapters validate --file ./manifest.json
pincer-agent adapters propose --file ./manifest.json
```

## Admin Activation Example

```bash
pincer-admin proposals list
pincer-admin proposals inspect <proposal-id>
pincer-admin proposals approve <proposal-id>
pincer-admin proposals reject <proposal-id> --reason "..."
```

Admins can also apply directly:

```bash
pincer-admin adapters apply --file ./manifest.json
pincer-admin adapters apply --url https://example.com/manifest.json
```

## Check Active Adapters

```bash
pincer-admin adapters list
pincer-agent adapters list
```
