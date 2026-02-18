# Open Source Release Checklist

Use this checklist before publishing or tagging a release.

## 1) Baseline Validation

```bash
npm ci
npm run oss:guard
npm run release:check
```

## 2) Secret Scanning

Working tree scan:

```bash
npm run secrets:scan
```

History scan (full repo):

```bash
npm run secrets:scan:history
```

Notes:
- `secrets:scan*` requires `gitleaks` installed locally.
- CI also runs gitleaks on push/PR via `.github/workflows/secrets.yml`.

## 3) Clean-Machine Smoke Run

```bash
npm run smoke:clean
```

Then execute the manual cloud flow printed by the script:
- `pincer-admin setup`
- `pincer-agent connect ...`
- propose/apply/call an adapter end-to-end.

## 4) Release Metadata

- Ensure package versions are bumped.
- Ensure `CHANGELOG.md` is updated.
- Ensure README/docs match the shipped CLI commands.
- Confirm repository metadata points to: `https://github.com/dhannusch/pincer`.

## 5) Publish

Use GitHub Actions:
- `Release (Manual)` workflow in `.github/workflows/release.yml`.

Required secret:
- `NPM_TOKEN`
