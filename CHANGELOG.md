# Changelog

All notable changes to this project will be documented in this file.

## [0.2.3] - 2026-06-29

Versioned the docs as release artifacts and tightened Polaris workspace
operation around local stack behavior, portal UX, and runtime state handling.

### Added

- Added a versioned docs viewer app under `apps/docs` with release snapshots,
  inline diffs, and a maintained `latest` track.
- Added a frozen `0.2.3` docs snapshot so the current release can be compared
  against future documentation updates.

### Changed

- Updated Polaris docs structure and release metadata to treat docs as
  versioned product artifacts instead of a single mutable tree.
- Refined local Polaris stack behavior around host-run services, local Paseo
  app routing, and workspace runtime readiness checks.
- Tightened portal workspace UX around user-scoped workspace resolution,
  provisioning progress handling, and create-flow controls.
- Clarified Polaris isolation and user-management semantics, especially around
  shared user identity state, workspace runtime state, and runtime credential
  behavior.

## [0.2.2] - 2026-06-28

Expanded the Polaris web portal, host executor flow, and live credential
runtime switching for local and deployed workspaces.

### Added

- Added the Polaris web portal workspace create, delete, status, asset
  preview, and credential management flow.
- Added asynchronous workspace provisioning through the executor-backed portal
  control plane.
- Added per-harness live credential switching and runtime status reporting for
  `ssh`, `codex`, `claude`, `copilot`, `opencode`, and `pi`.
- Added user-scoped Paseo daemon visibility so portal users only see their own
  workspace runtime pairings.

### Changed

- Refined Polaris deployment to run the CLI and executor on the host while the
  web portal and API stack stay compose-managed.
- Reworked workspace status UI around driver controls, embedded Paseo runtime
  state, and credential-aware runtime inspection.
- Simplified Polaris portal auth so Clerk-backed sign-in, sign-up, and user
  bootstrap are decoupled from local Polaris user creation.
- Updated workspace rendering, provisioning, and rebuild handling so Dockerfile
  drift is detected and refreshed before runtime start.
- Hardened live runtime credential material writes and executor status refresh
  behavior for real workspace containers.

### Removed

- Removed older direct agent-toggle assumptions from workspace creation in
  favor of runtime-ready defaults and credential-driven activation.

## [0.2.1] - 2026-06-24

Stabilized Polaris backend switching across Docker and KubeVirt for shared
workspace state.

### Added

- Added stronger switch coverage for Docker and KubeVirt migration and
  selection handling.
- Added KubeVirt guest bootstrap helpers for shared-state sync and daemon
  recovery in cloud-init.

### Changed

- Updated Docker workspace volume handling to respect rendered NetFS source
  configuration before start and rebuild.
- Hardened Docker, Pod, and KubeVirt runtime bootstrap flow so Paseo daemon
  readiness is retried and validated instead of assumed.
- Improved KubeVirt guest probing to use direct node SSH when available and to
  wait for guest runtime readiness after start.
- Refined backend switching flow to better coordinate state export/import and
  KubeVirt handoff timing.

## [0.2.0] - 2026-06-23

Expanded Polaris profile switching, credential scaffolding, and KubeVirt
workspace support.

### Added

- Added a `switch` CLI command to move workspaces across supported Polaris
  backends.
- Added credential-oriented config scaffolding for Codex and Claude user
  profiles.
- Added KubeVirt VM and cloud-init templates plus a dedicated `demo` project
  spec.
- Added an OpenSpec change for the credential entity model and related
  workspace attachment specs.
- Added operator scripts for building KubeVirt root disk images and printing
  k3s worker join details.
- Added a repo-level `skills/use-polaris/SKILL.md` guide.

### Changed

- Refined backend renderers and drivers across Docker, Pod, and KubeVirt to
  support switching and guest runtime improvements.
- Expanded Polaris config loading, scaffolding, workspace handling, and state
  tracking.
- Strengthened CLI, end-to-end, and evolution test coverage around backend
  switching and credential setup.
- Moved Polaris docs from `apps/polaris/docs` into `docs/polaris` and refreshed
  top-level documentation links.
- Renamed sandbox setup scripts to reflect broader k3s runtime support.

### Removed

- Removed older `morpheus` demo project specs in favor of the current `demo`
  profile set.
- Removed the app-local Polaris skill copy and the obsolete Paseo smoke test
  script.

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
