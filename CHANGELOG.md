# Changelog

All notable changes to this project will be documented in this file.

## [0.2.0] - 2026-02-19

### Changed

- Switched admin auth from static passphrase headers to bootstrap + session cookie + CSRF.
- Added a worker-served Admin UI at `/admin` for day-to-day operations.
- Added encrypted KV-backed secret vault APIs and runtime secret resolution fallback behavior.
- Added runtime rotation and pairing generation as authenticated worker admin APIs.
- Refactored `pincer-admin` to use username/password session login against admin APIs.

## [0.1.0] - 2026-02-17

### Added

- Manifest-driven dynamic adapter registry in worker.
- Runtime-authenticated adapter proposal flow.
- Admin apply/list/disable/secret rotation commands.
- OpenClaw skill updates for proposal and update lifecycle.
- OSS governance and CI/release scaffolding.
