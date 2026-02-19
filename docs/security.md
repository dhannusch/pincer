# Security Model

Pincer treats the local host as potentially hostile. Provider API keys never leave the Worker.

## Auth Layers

Every runtime proposal/call request is verified with two mandatory controls.

### 1. Runtime bearer key (mandatory)

Agent sends `Authorization: Bearer <keyId>.<keySecret>`.
Worker hashes the presented secret and compares to `runtime:active.keyHash` from KV.

### 2. HMAC signature (mandatory)

Agent signs `METHOD\npath\ntimestamp\nsha256(body)` with shared HMAC-SHA256 secret.
Worker recomputes and validates.

Headers:
- `x-pincer-timestamp`
- `x-pincer-body-sha256`
- `x-pincer-signature` (`v1=<hex>`)

## Adapter Manifest Guardrails

Before proposal/apply activation:
- manifest JSON schema is validated
- only HTTPS base URLs are allowed
- action paths must resolve to allowed hosts
- wildcard hosts are rejected
- required secret bindings are explicit

At runtime:
- only active manifest adapters are callable
- input is validated against manifest `inputSchema`
- outbound host must be in `allowedHosts`
- missing secret bindings fail closed

## Additional Controls

- Worker sanitizes internal error output.
- Pairing codes are one-time use.
- Admin endpoints require session cookie auth plus CSRF for state-changing requests.
- Proposal lifecycle events are persisted to KV audit records (`proposal_submitted`, `proposal_approved`, `proposal_rejected`).

## Pairing Code Security

`POST /v1/connect` is the only unauthenticated endpoint (besides health).
It is protected by:
- pairing code entropy (40 bits for current 8-character base32-style format)
- short lifetime
- one-time use deletion

## Documented Trade-offs

- In-memory metrics snapshots are isolate-local and reset on worker lifecycle events.
- `~/.pincer/credentials.json` (agent host) and admin credential env vars on the admin host are sensitive and should be protected as secrets.
