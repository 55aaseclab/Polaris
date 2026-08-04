## Why

Polaris has most of the 0.3 perimeter primitives, but the current release
record still describes a 50-100-user system and several safety contracts are
only tested in isolation. We need a defensible 0.3.0 release profile for 5-10
active users on one host, with production ownership of writes, jobs, storage,
backups, and promotion evidence instead of relying on Wanghai-local behavior.

## What Changes

- Define 0.3.0 as a single-host deployment supporting at most 10 concurrently
  active user tenants, with one Polaris control process and bounded workers.
- Replace the obsolete 50/100 capacity claim with staged 2/5/10-user evidence,
  explicit SLOs, storage budgets, noisy-neighbor checks, and failure recovery.
- Turn the existing control-store idempotency and workspace-lock primitives into
  an active semantic write envelope for integrated Wanghai mutations, including
  durable results, optimistic version checks, and semantic audit events.
- Complete the Polaris-owned durable job contract for provisioning and the
  integrated workflow, analysis, derived-work, and outbound-action boundaries;
  Wanghai remains a surface and does not execute integrated jobs directly.
- Add an authorized, encrypted, tenant-qualified Polaris backup and restore
  lifecycle with retention, rollback, and isolation-drill evidence.
- Add enforceable logical storage quotas, resource admission/limits, and
  operator-visible metrics and alerts appropriate for the single-host profile.
- Require digest-pinned, signed, attestated Polaris/Wanghai release artifacts and
  a candidate manifest before remote promotion; retain fail-closed ingress and
  Authing requirements.
- Keep standalone Wanghai, its external identity adapter, and Polaris 0.3.1 out
  of this change.

## Capabilities

### New Capabilities

- `polaris-release-profile`: The supported 5-10-user single-host topology,
  SLOs, evidence stages, and go/no-go rules.
- `semantic-surface-mutations`: Polaris-issued idempotency, workspace locking,
  optimistic concurrency, durable results, and semantic audit for integrated
  Wanghai writes.
- `durable-surface-jobs`: Bounded, recoverable Polaris jobs for integrated
  surface work, leases, retries, cancellation, and audit.
- `integrated-backup-restore`: Polaris-owned encrypted backup, retention,
  tenant-qualified restore, rollback, and isolation verification.
- `resource-storage-governance`: Logical quotas, resource admission, bounded
  concurrency, usage accounting, metrics, and alerts.
- `signed-release-promotion`: Immutable image digests, SBOM/provenance/signing,
  candidate manifests, fail-closed preflight, and rollback verification.

### Modified Capabilities

No existing OpenSpec capabilities are present in this repository. The change
establishes the release contracts above from the current implementation and
canonical release documentation.

## Impact

- Polaris control-store, gateway, portal/server, runtime operations, backend
  renderers, configuration, migration, deployment, and release-preflight code.
- Integrated Wanghai gateway routes and surface policies, without moving
  identity, rate-limit, quota, lifecycle, or job authority into Wanghai.
- Docker/host and Kubernetes deployment manifests, registry promotion, Authing,
  TLS/DNS, backup storage, and the designated remote staging host.
- Canonical release TODO, plan, capacity, evidence, and surface-boundary docs.
- No standalone Wanghai API contract or 0.3.1 implementation.
