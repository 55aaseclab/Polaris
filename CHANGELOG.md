# Changelog

All notable changes to this project are documented in this file. Versions are
ordered newest first.

## [Unreleased]

### Added

- Four thin cve tools on the CLH (PRD 3.11/3.14): deterministic fetch,
  api-backend knowledge/plan presets, dsh-backend setup/exploit/verify
  with in-tool dev-critic convergence and at most 5 verifier revisions;
  no attempt-level retries in tools; receipt values carry costUsd/tokens.
- Tool inventory registration for the four cve tools with
  `CveGenieTrial` as a workflow consumer; `pack list` shows zero
  catalog warnings and fail-closed is preserved.
- API idempotency (PRD 3.11): REST POST `/api/workflow-runs` accepts
  an `Idempotency-Key` header or `idempotencyKey` body field; the same
  tenant + key returns the same run.
- Configurable LLM harness (PRD 3.14): `packages/llm-harness` with a
  preset schema (api/bounded/open kinds), an api backend with usage
  readback and fail-closed credentials, a dsh backend compiler and
  wrapper parsing session logs into receipts, a dispatcher seam via
  the dsh `runnerCommand` override, and eight CVE-Genie-mapped
  presets with vendored Apache-2.0 prompt templates.
- Budget and attempt hierarchy (PRD 3.10.9): run-level budget/timeout
  cap with stable stop error codes, per-step maxAttempts and
  flow-level budgetUsd/timeoutMs in the `.ord` grammar, and
  structured error values threaded to the Portal.
- DSL v2 structured orchestration (PRD 3.13): `.ord` gains sequence,
  parallel (fork-join), choice, forEach, while, and subflow, with
  structural interpretation, DAG validation, per-branch step policy,
  and Portal timeline/graph rendering. Linear v1 packs stay valid.
- Step-level retry and budget policy (PRD 3.10): per-step
  maxAttempts/timeoutMs/budgetUsd, env-configurable, with
  `maxAttempts=1` by default so unconfigured behavior is unchanged.
- Per-attempt receipts surfaced in the Portal timeline with
  collapsible attempt grouping (PRD 3.3.5).
- `synthetic.step.policy` fixture tool for step-policy tests.

## [0.4.0] - 2026-09-11

Released the host workflow slice on the shipped `0.3.4` single-host
baseline. Ordinary Portal work can run `AutoResearch` / `LiteratureReview`
as a host run. Vault-target runs stay `mode: "mock"`. A real
`mode: "vault"` executor and `ops workflow-smoke` remain planned work,
tracked in the product PRD.

### Added

- Durable host workflow admission for `driver=none`, persisted as
  `mode: "host"`.
- Same-run retry: failed or cancelled runs requeue the same run id and
  skip completed steps.

### Changed

- First-party Literature Review is the `AutoResearch` pack at
  `packs/autoresearch/`. Skills live next to their tool or pack under
  `<owner>/skills/`; the repository-level `skills/` tree is gone.
- Removed `packs/vault-knowledge-health`.

### Deferred

- Real `mode: "vault"` execution and Vault-target `ops workflow-smoke`.
- Additional live executor families beyond the operator-only
  `vault.artifact.metadata.read` pilot.
- A new designated-host candidate. This source tag does not require a
  new m00 promotion.

## [0.3.4] - 2026-09-11

Released the single-host working baseline after the archived 0.3.3
capacity ship. This release keeps the reviewed envelope at 20 active vaults
and consolidates the control/vault-data, Portal, Paseo, and Wanghai-migration
state. Workflow live tools remain out of this release.

### Current state

- Polaris remains the only integrated control plane for identity, tenant and
  vault ownership, capability checks, gateway sessions, quotas, lifecycle,
  durable jobs, audit, backup/restore, ingress, and deployment policy.
- The control store and vault data use separate canonical roots; the old
  layout is migrated and archived rather than read through a compatibility
  fallback.
- Portal is an independent React application under `apps/polaris-portal`,
  while the Polaris-owned Paseo integration lives under `packages/paseo`.
- Portal's visual system is aligned with Paseo and the deployed m00 smoke
  checks remain healthy.

### Wanghai migration boundary

- Migrated Wanghai Literature Review execution, history import, shared tools,
  business surface, skills, and third-party coursework into Polaris-owned
  workflow, tool, business-core, Portal, skill, and third-party locations.
- Kept the Literature Review import historical-only and receipt-verified;
  Polaris does not treat legacy Wanghai completion records as new durable
  workflow runs.
- Wanghai is now a private surface repository. Its deployment files and
  fixed-mount format adapters remain there because Polaris owns the integrated
  lifecycle and release policy.

### Deferred

- Re-run host-bound manifest generation and read-only remote checks after the
  source tag when a new designated-host candidate is cut.
- Close or explicitly defer the remaining external perimeter, authenticated
  tenant-matrix, restart-safety, supply-chain, and operator-approval gaps.
- Workflow live tools, operator UX validation, and the next release identity
  remain planned work, tracked in the product PRD.

## [0.3.3] - 2026-08-09

Released the single-host active-vault ceiling raise from 10 to 20, with a
measured resource baseline and test-host evidence. Open 0.3.2 perimeter items
(authenticated tenant matrix, full SPDX clean-host policy, human go/no-go) are
not reopened by this capacity release.

### Added

- Added `benchmark:concurrent-users` to measure concurrent multi-user portal
  and gateway load with distinct oauth2-proxy identities.
- Added a unit test that admits the 20th active vault and rejects the 21st.
- Published the twenty-user host resource baseline (memory, CPU, storage,
  network) from linear hot-vault measurements.

### Changed

- Raised `config/release-profiles/0.3.0-single-host.json` `maxActiveVaults`
  from 10 to 20 and aligned provision defaults and release-identity bumps.
- Allowed `POLARIS_AUTH_MODE=disabled` only when
  `POLARIS_RELEASE_GATE_MODE=local-test`, so the designated test host can
  smoke-check capacity bring-up without Authing. Production still requires
  Authing browser sessions.
- Extended the default capacity-gateway stages to include a 20-user step.

## [0.3.2] - Unreleased

Started the signed workspace-base image promotion path for the 0.3.2 release.

This remains an unreleased candidate while clean-host attestation verification,
the authenticated external tenant matrix, and production approval are open.

### Added

- Added a GitHub Actions workflow that publishes the Polaris workspace base to
  GHCR with a digest output, SPDX SBOM, SLSA provenance, and keyless Cosign
  signature verification.
- Added a regression test for the workflow contract and its clean-checkout
  Docker context.
- Reduced the base image's default Rust profile to minimal while retaining
  `rustfmt` and `clippy`, and removed the npm download cache after installation.
- Added a pinned Rekor-free Sigstore signing configuration for the large SPDX
  attestation; image signatures and SLSA provenance remain transparency-log
  backed.

### Changed

- Bumped the release candidate identity to `0.3.2`.
- Recorded formal-origin probes for `polaris.jianxiaoyitech.com`.
- Added a regression guard for scoped two-vault Paseo coding routes and mutable
  Expo `scope` query parameters.

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
- Integrated Wanghai uses the fixed `/vault/workspaces`, `/vault/backups`, and
  `/vault/cache` mounts; it no longer uses a shared `/vault/project` root.

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
