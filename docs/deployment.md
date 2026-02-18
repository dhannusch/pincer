# Deployment Guide

This document explains how to deploy the Pincer Worker safely in open-source environments.

## Config File Strategy

Pincer uses a template-based Wrangler config workflow:

- Template (tracked): `apps/pincer-worker/wrangler.toml.example`
- Local config (generated): `apps/pincer-worker/wrangler.toml`

The local file is gitignored so account-specific IDs are not committed.

## Bootstrap

```bash
npm run bootstrap
```

## First-Time Setup

```bash
pincer-admin setup
```

What setup does:
- Ensures local `wrangler.toml` exists (copies from template if missing).
- Provisions KV for `PINCER_CONFIG_KV`.
- Writes runtime configuration and pairing records into KV.
- Writes Worker secrets.
- Deploys the worker.

## Generate Additional Pairing Codes

```bash
pincer-admin pairing generate
```

## Updating Secrets

```bash
pincer-admin adapters secret set <SECRET_BINDING>
```

## Notes

- Do not commit `apps/pincer-worker/wrangler.toml`.
- Do not commit credentials files under `~/.pincer`.
