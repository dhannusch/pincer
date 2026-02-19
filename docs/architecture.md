# Pincer Architecture

## Components

- `pincer-worker`: request boundary and dynamic adapter runtime on Cloudflare Workers.
- `pincer-admin`: guided setup + readiness checks + adapter apply/manage commands.
- `pincer-agent`: connect + signed runtime call CLI + proposal submission.

## Configuration Model

Pincer uses KV for config/session/vault state and Worker Secrets for bootstrap + fallback secret bindings.

### KV keys

- `meta:version`: config version string.
- `runtime:active`: runtime auth metadata (key hash, key-secret binding, HMAC binding, skew).
- `adapter_registry:index`: adapter registry index (`proposals` + `active`).
- `adapter_registry:proposal:<proposalId>`: pending proposal record + manifest.
- `adapter_registry:manifest:<adapterId>:<revision>`: immutable manifest snapshots.
- `pairing:<CODE>`: one-time pairing credentials.
- `admin:user:primary`: single admin account metadata.
- `admin:session:<sessionId>`: session records (cookie auth + CSRF).
- `admin:login:<username>:<clientId>`: login lockout/backoff counters.
- `vault:secret:<binding>`: encrypted write-only secret entries.

### Worker secrets (required)

- `PINCER_BOOTSTRAP_TOKEN`
- `PINCER_VAULT_KEK`
- runtime fallback secret bindings (defaults: `PINCER_HMAC_SECRET_ACTIVE`, `PINCER_RUNTIME_KEY_SECRET_ACTIVE`)
- optional adapter fallback secret bindings declared in manifests (`requiredSecrets`)

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

1. `pincer-admin setup` deploys worker resources and prints `/admin/bootstrap` instructions.
2. Admin bootstraps first account in `/admin/bootstrap`.
3. Admin generates pairing code in UI or `pincer-admin pairing generate`.
4. Worker stores one-time pairing credentials in KV.
5. `pincer-agent connect <host> --code <CODE>` exchanges the code for credentials.
6. Worker deletes pairing record after first use.
