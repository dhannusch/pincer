# Release Guide

Pincer uses manual releases with CI validation.

Repository: https://github.com/dhannusch/pincer

## Packages Published

- `@pincerclaw/admin`
- `@pincerclaw/agent`
- `@pincerclaw/shared-types`

Worker source is distributed via repository source.

## Pre-Release Checklist

1. Update docs/changelog as needed.
2. Ensure versions are bumped for packages being released.
3. Run:

```bash
npm run oss:guard
npm run release:check
npm run secrets:scan
npm run secrets:scan:history
npm run smoke:clean
```

Full checklist:
- `docs/open-source-checklist.md`

## GitHub Actions Manual Release

Use the `Release (Manual)` workflow.

Inputs let you choose which packages to publish.

Required secret:
- `NPM_TOKEN`

## Local Manual Publish (fallback)

```bash
npm publish --workspace @pincerclaw/shared-types --access public
npm publish --workspace @pincerclaw/admin --access public
npm publish --workspace @pincerclaw/agent --access public
```

## Post-Release

- Create or update GitHub release notes.
- Announce notable changes and migration notes.
