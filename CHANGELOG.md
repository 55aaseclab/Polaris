# Changelog

All notable changes to this project will be documented in this file.

## [0.1.0] - 2026-06-21

Initial Polaris release.

### Added

- Introduced Polaris as the workspace control plane with a multi-app layout under `apps/polaris`.
- Added Docker, Pod, and KubeVirt backend support with generated manifests and runtime inspection.
- Added workspace and user profile separation, including config-owned user profiles and bootstrap secrets layout.
- Added Paseo-based runtime integration for Codex and Claude style external coding agents.
- Added the Polaris evolution kernel, runtime observer, retrieval, review, and curator pipeline.
- Added a Debian 13 demo Docker image and a ready-to-run `demo@docker` workspace path.
- Added TypeScript CLI commands for `create`, `render`, `apply`, `start`, `stop`, `restart`, `rebuild`, `status`, `reconcile`, and `logs`.
- Added OpenSpec changes/specs and repo-local Codex skills for propose/apply/explore flows.
- Added operator docs for runtime layout, evolution kernel, maturity map, and workspace tooling.
- Added automated test coverage reporting via `pnpm --dir apps/polaris run test:coverage`.

### Changed

- Replaced the older Python `agentctl` control-plane path with the TypeScript Polaris implementation.
- Refactored repository structure around app-owned code, docs, assets, and tests.
- Moved workspace tooling config under `config/tooling` and cleaned deprecated config layout.
- Tightened `.gitignore` and local runtime artifact handling for generated state, secrets, and coverage output.
- Improved evolution lesson explainability, trigger parsing, runtime observer robustness, and coverage.

### Removed

- Removed deprecated Docker compose, Headlamp, and legacy platform paths no longer used by Polaris.
- Removed legacy generated/spec trees tied to the previous control-plane organization.
- Removed obsolete Python tests and setup scripts replaced by the Polaris TypeScript workflow.
