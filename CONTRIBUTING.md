# Contributing

Thanks for contributing to Pincer.

## Development Setup

1. Install Node.js LTS (20.x recommended).
2. Clone the repo.
3. Run:

```bash
npm run bootstrap
```

If you do not want global CLI links:

```bash
npm install
```

## Repository Layout

- `apps/pincer-worker`: Cloudflare Worker runtime boundary
- `apps/pincer-admin`: admin CLI
- `apps/pincer-agent`: agent CLI
- `packages/pincer-shared-types`: shared auth + manifest types/validation

## Running Checks

Before opening a PR:

```bash
npm run oss:guard
npm run release:check
```

Recommended before release work:

```bash
npm run secrets:scan
npm run smoke:clean
```

## Pull Request Guidelines

- Keep changes scoped and explain tradeoffs in the PR description.
- Add tests for behavior changes.
- Update docs when changing commands, APIs, or workflows.
- Avoid committing secrets, Cloudflare IDs, or local credentials.

## Commit/Release Notes

PR title and summary should clearly state:
- what changed
- why
- any migration or user impact

## Questions

Use GitHub Issues for feature requests and bugs.
For security issues, see `SECURITY.md`.
