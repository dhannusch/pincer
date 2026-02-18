# Pincer Architecture

## Components

- `pincer-worker`: request boundary and dynamic adapter runtime on Cloudflare Workers.
- `pincer-admin`: guided setup + readiness checks + adapter apply/manage commands.
- `pincer-agent`: connect + signed runtime call CLI + proposal submission.

## Configuration Model

Pincer uses KV for non-secret config and Worker Secrets for sensitive values.

### KV keys

- `meta:version`: config version string.
- `runtime:active`: runtime auth metadata (key hash, HMAC binding, skew).
- `adapter_registry:index`: adapter registry index (`proposals` + `active`).
- `adapter_registry:proposal:<proposalId>`: pending proposal record + manifest.
- `adapter_registry:manifest:<adapterId>:<revision>`: immutable manifest snapshots.
- `pairing:<CODE>`: one-time pairing credentials.

### Worker secrets (required)

- `PINCER_ADMIN_PASSPHRASE`
- runtime HMAC binding (default: `PINCER_HMAC_SECRET_ACTIVE`)
- adapter-specific secret bindings declared in each manifest (`requiredSecrets`)

## Request Flow

1. OpenClaw runtime calls `pincer-agent call`.
2. Agent signs request body + path + timestamp with HMAC-SHA256.
3. Worker validates runtime key hash and HMAC signature.
4. Worker resolves adapter/action from active manifest registry.
5. Worker validates `input` against manifest `inputSchema`.
6. Worker injects provider secret binding and calls upstream.
7. Worker returns sanitized output and emits metrics.

Runtime discovery is available via `GET /v1/adapters` (runtime-authenticated, enabled adapters only).

## Proposal + Apply Flow

1. Agent submits proposal via `POST /v1/adapters/proposals` with runtime auth.
2. Worker validates manifest and stores pending proposal.
3. Admin lists proposals via `GET /v1/admin/adapters/proposals`.
4. Admin inspects proposals via `GET /v1/admin/adapters/proposals/:proposalId`.
5. Admin approves via `POST /v1/admin/adapters/apply` (`proposalId`) or rejects via `POST /v1/admin/adapters/proposals/:proposalId/reject`.
6. Worker validates revision/update rules, checks required secrets, and activates adapter on approval.
7. Worker writes proposal audit events (`proposal_submitted`, `proposal_approved`, `proposal_rejected`) retrievable via `GET /v1/admin/audit`.

## Update Model

Adapter updates are explicit:
- same `id`
- higher `revision`

If `revision` is unchanged, content must also be unchanged.

## Pairing Flow

1. `pincer-admin setup` generates runtime credentials and one-time pairing code.
2. Pairing code + credentials are stored in KV.
3. `pincer-agent connect <host> --code <CODE>` exchanges the code for credentials.
4. Worker deletes the pairing record after first use.
5. Agent saves credentials to `~/.pincer/credentials.json` and installs the OpenClaw skill.
