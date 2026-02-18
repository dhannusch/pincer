# pincer-worker

Cloudflare Worker runtime boundary for manifest-driven adapter calls.

## Runtime Model

- Adapter definitions are loaded from KV manifest registry.
- Runtime auth is enforced by bearer runtime key + HMAC signature.
- Non-secret config is read from Workers KV (`PINCER_CONFIG_KV`).
- Secret values are read from Worker secrets.
- Cloudflare config is generated from `wrangler.toml.example` into local `wrangler.toml`.

## KV Keys

- `meta:version`
- `runtime:active`
- `adapter_registry:index`
- `adapter_registry:proposal:<proposalId>`
- `adapter_registry:manifest:<adapterId>:<revision>`
- `audit:proposal:<occurredAt>:<eventId>`
- `pairing:<CODE>`

## Endpoints

- `GET /v1/health`
- `POST /v1/connect`
- `GET /v1/adapters`
- `POST /v1/adapters/proposals`
- `POST /v1/adapter/:adapter/:action`
- `GET /v1/admin/doctor`
- `GET /v1/admin/metrics`
- `GET /v1/admin/adapters/proposals`
- `GET /v1/admin/adapters/proposals/:proposalId`
- `POST /v1/admin/adapters/proposals/:proposalId/reject`
- `GET /v1/admin/audit`
- `GET /v1/admin/adapters`
- `POST /v1/admin/adapters/apply`
- `POST /v1/admin/adapters/:adapter/disable`
- `POST /v1/admin/adapters/:adapter/enable`

## Commands

```bash
# Generate local wrangler config from template (or let `pincer-admin setup` do it)
cp apps/pincer-worker/wrangler.toml.example apps/pincer-worker/wrangler.toml

# Deploy/setup path
pincer-admin setup

npm --workspace @pincer/worker run dev
npm --workspace @pincer/worker run deploy
npm --workspace @pincer/worker run test
```
