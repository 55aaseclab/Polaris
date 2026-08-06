# Changelog

All notable changes to this project are documented in this file. Versions are
ordered newest first.

## [0.3.1] - 2026-08-06

Released the controlled test-host performance update without changing the
supported user profile, storage allocation, or production-readiness claim.

### Changed

- Removed unnecessary full-vault summary work from the Wanghai gateway target
  lookup path.
- Removed repeated static-asset reconstruction from the Portal host-list path
  while retaining tenant and selected-runtime checks.
- Protected remote source sync from local user configuration and local Paseo
  surface artifacts.

### Post-release Performance Maintenance

- Avoided duplicate backend status synthesis for durable provisions that do not
  request `startAfterCreate`, while retaining the post-start reconciliation.
- Added isolated control-store, durable-worker, and bounded-mutation benchmark
  paths with scoped V8 CPU-profile capture.
- Recorded the local before/after worker evidence in the documentation site;
  this follow-up was not promoted to the designated test host.

### Release Evidence

- Recorded reproducible paired gateway and Portal host-list measurements on the
  fixed 10-vault test fixture.
- Deployed source `320e949` through the controlled blue/green test-host path.

## [0.3.0] - 2026-08-05

Released the controlled single-host Docker test profile for Polaris and its
vault-scoped Wanghai surface. Formal production promotion remains separate.

### Added

- Added durable Polaris-owned Wanghai mutation admission, quota reservation,
  audit, backup, restore, and recovery controls.
- Added release manifests, preflight validation, bounded active-vault capacity,
  resource limits, and test-host recovery coverage.
- Added the Polaris gateway mount for the integrated Wanghai surface.

### Changed

- Consolidated user, vault, lifecycle, ingress, rate-limit, quota, durable-job,
  and audit authority in Polaris.
- Kept Wanghai vault-scoped and prevented it from becoming a second control
  plane.

### Release Scope

- Released only for the designated HTTP test host and its bounded 5-10 active
  user profile.
- Deferred signed external images, provenance, SBOM, formal TLS/DNS, external
  production evidence, and Standalone Wanghai to later releases.

## [0.2.8] - 2026-08-03

### Fixed

- Hardened Authing regression coverage and bounded managed workspace image tags
  to valid registry references.

## [0.2.7] - 2026-07-11

Shipped Polaris deployment packaging as a release artifact, with full
telemetry wiring and a new frozen docs snapshot for the release line.

### Added

- Added native Polaris release packaging, including CLI and desktop entry
  distribution.
- Added PostHog and Sentry telemetry coverage across deployment, runtime,
  product, environment, and error events.
- Added a frozen `0.2.7` docs snapshot.

### Changed

- Updated release build scripts and CI for native deployment artifacts.
- Updated deployment defaults, release manifests, and web telemetry metadata
  to use `0.2.7` as the current release snapshot.
- Updated maintained docs and release notes to document deployment, packaging,
  and telemetry behavior.

## [0.2.6] - 2026-07-08

Expanded Polaris workspace skill management, tightened runtime status handling,
and refined portal workspace UX around admin-scoped navigation and sidebar
responsiveness.

### Added

- Added user skill registry and workspace runtime skill install, uninstall,
  list, and sync flows.
- Added a frozen `0.2.6` docs snapshot.
- Added regression coverage for admin-pane workspace entry and sidebar refresh
  behavior.

### Changed

- Unified workspace runtime status semantics and narrowed portal lifecycle
  handling around cached runtime and Paseo state.
- Updated admin-scoped workspace routing and sidebar behavior to react faster
  when entering a workspace from the admin pane.
- Updated docs release metadata and changelog baseline to use `0.2.6` as the
  current release snapshot.

## [0.2.5] - 2026-06-30

Hardened Polaris user and workspace control-plane mutation handling around
workspace lifecycle, portal admin deletion, and scoped workspace operations.

### Added

- Added a dedicated workspace lifecycle lock for provision, switch, start,
  stop, archive, delete, live credential switching, and workspace agent
  binding operations.
- Added regression coverage for same-workspace mutation serialization,
  user-scoped switch behavior across duplicate workspace names, queued
  provision protection during user deletion, and lock-consistent delete
  rollback recovery.
- Added a frozen `0.2.5` docs snapshot.

### Changed

- Updated workspace create, archive, delete, and executor provision flow to
  serialize through user and workspace lifecycle locks.
- Updated portal workspace switch to resolve through explicit user scope.
- Updated user deletion rollback to snapshot state only after the user lock is
  held.
- Updated docs release metadata and changelog baseline to use `0.2.5` as the
  current release snapshot.

## [0.2.4] - 2026-06-29

Reorganized Polaris documentation around customer-facing product flows and
retired the older single-page technical write-ups in favor of sectioned docs.

### Added

- Added customer-oriented Polaris doc sections for onboarding, governed use,
  shared infrastructure, and member exit and handover.
- Added a frozen `0.2.4` docs snapshot for the reorganized documentation
  structure.

### Changed

- Reworked the Polaris docs information architecture so customer outcomes are
  the primary entry point and technical depth is distributed into focused
  sub-documents.
- Merged older technical notes into the new section docs and their `others`
  pages instead of keeping separate top-level maturity pages for the same
  topics.
- Updated docs navigation, version metadata, and diff generation to use
  `0.2.4` as the current release baseline.

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

- Introduced Polaris as the workspace control plane with a multi-app layout
  under `apps/polaris`.
- Added Docker, Pod, and KubeVirt backend support with generated manifests and
  runtime inspection.
- Added workspace and user profile separation, including config-owned user
  profiles and bootstrap secrets layout.
- Added Paseo-based runtime integration for Codex and Claude style external
  coding agents.
- Added the Polaris evolution kernel, runtime observer, retrieval, review, and
  curator pipeline.
- Added a Debian 13 demo Docker image and a ready-to-run `demo@docker`
  workspace path.
- Added TypeScript CLI commands for `create`, `render`, `apply`, `start`,
  `stop`, `restart`, `rebuild`, `status`, `reconcile`, and `logs`.
- Added OpenSpec changes/specs and repo-local Codex skills for propose/apply/
  explore flows.
- Added operator docs for runtime layout, evolution kernel, maturity map, and
  workspace tooling.
- Added automated test coverage reporting via
  `pnpm --dir apps/polaris run test:coverage`.

### Changed

- Replaced the older Python `agentctl` control-plane path with the TypeScript
  Polaris implementation.
- Refactored repository structure around app-owned code, docs, assets, and
  tests.
- Moved workspace tooling config under `config/tooling` and cleaned deprecated
  config layout.
- Tightened `.gitignore` and local runtime artifact handling for generated
  state, secrets, and coverage output.
- Improved evolution lesson explainability, trigger parsing, runtime observer
  robustness, and coverage.

### Removed

- Removed deprecated Docker compose, Headlamp, and legacy platform paths no
  longer used by Polaris.
- Removed legacy generated/spec trees tied to the previous control-plane
  organization.
- Removed obsolete Python tests and setup scripts replaced by the Polaris
  TypeScript workflow.
