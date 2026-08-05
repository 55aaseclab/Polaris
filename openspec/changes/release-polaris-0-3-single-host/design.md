## Context

Polaris currently has a durable SQLite control store, gateway assertions,
rate-limit buckets, provisioning jobs, audit chaining, migration tooling, and
renderer hardening. The missing work is integration and operational proof:
Wanghai mutations do not use the control-store idempotency/lock methods,
integrated surface jobs are not all registered, quotas are not enforceable
across the supported host path, and promotion/evidence is incomplete.

The release target is deliberately one host and 5-10 concurrently active
single-user tenants. The designated remote host is a Docker host, so the
release capacity claim is for the Docker topology. Pod and KubeVirt remain
supported code paths, but they do not inherit the Docker capacity claim without
separate deployed evidence.

## Goals / Non-Goals

**Goals:**

- Ship a fail-closed integrated Polaris/Wanghai release for at most ten active
  tenants on one host.
- Make every exposed integrated mutation, job, backup, quota, and promotion
  path owned by Polaris and recoverable after restart.
- Prove two-tenant isolation, 2/5/10-user capacity, restart recovery, backup
  restore, and immutable promotion with redacted evidence.

**Non-Goals:**

- Standalone Wanghai identity or production standalone deployment; that is
  Polaris 0.3.1 work.
- Multi-host Polaris replicas, multi-region operation, or zero-downtime
  failover. SQLite remains the single-host control store.
- A shared multi-tenant Wanghai service. Each integrated surface remains
  vault-scoped.
- Reopening direct Wanghai workflow execution, live SMTP, or backup scripts
  without a Polaris-owned admission and audit path.

## Decisions

### Single-host release profile

Use one Polaris server process, one bounded in-process job worker pool, one
SQLite WAL control store on durable local storage, and no gateway replicas.
Cap active vaults at ten and set release job concurrency to one until measured
evidence supports two. The deployment preflight rejects public Wanghai port
mappings, a missing single-origin HTTPS endpoint, mutable image references, and
uninspectable Docker state.

Use the Polaris origin with a fixed `/wanghai/` path. Polaris strips the path
before applying Wanghai policy and preserves it when forwarding to the Next.js
surface, so no per-vault hostnames, wildcard DNS, or extra public origin are
needed.

### Integrated vault data and migration

Integrated Wanghai has no separate host data root. Polaris mounts one
tenant/vault-qualified directory from `POLARIS_NETFS_LOCAL_EXPORT_ROOT` at
`/vault/project`, then Wanghai derives `workspaces/`, `backups/`, and `cache/`
below that mount. The provisioning and migration paths use one canonical
relative layout:

```text
tenants/<canonical-tenant>/vaults/<canonical-vault>/
```

The migration command accepts a legacy shared root explicitly but always
targets the same Polaris vault export used by runtime provisioning. It must
never write below `POLARIS_WANGHAI_DATA_ROOT`, since that is not an integrated
runtime setting.

### Semantic mutation envelope

Define an allowlisted action catalog at the Polaris gateway. An unsafe Wanghai
request must carry a bounded Idempotency-Key and, when the action is
versioned, an If-Match workspace version. Polaris hashes the normalized
action/request, starts or replays the idempotency record, acquires the
tenant/vault/workspace lock, and forwards a short-lived signed admission
assertion.

Wanghai remains responsible for executing the admitted UI/API action and for
atomic local file replacement. It must not decide whether the caller is
entitled, whether the idempotency key is valid, or how much quota the tenant
has. The response includes the resulting workspace version and bounded result
metadata. Polaris completes the idempotency record, releases the lock, and
writes semantic audit; an in-flight duplicate is rejected or returned as a
replayable existing result, never executed twice.

Unknown or unclassified integrated mutations fail closed until they are added
to the action catalog. This is safer than pretending a route-level admission
event is a semantic write contract.

### Durable jobs

Extend the existing jobs table and worker lifecycle with a registered handler
interface. Every handler receives tenant, vault, actor, correlation, and
idempotency context; it runs under a lease, heartbeat, bounded retry policy,
cancellation checks, and a terminal audit event. A restart reclaims expired
leases and cannot create a second logical operation for the same dedupe key.

The first release handler set is vault provisioning, integrated workflow
submission/execution, intelligence-analysis completion, bounded derived
thumbnail/document work, and an outbound-action adapter that remains disabled
until its permission and outbox checks pass. Direct Wanghai workflow and
analysis execution continue to reject Polaris mode; the only integrated entry
point is a Polaris job submission route.

### Backup and restore

Polaris owns an adapter that snapshots one tenant-qualified vault root into an
external backup root. Archives are encrypted, checksummed, retention-limited,
and bound to tenant and vault metadata. Restore always targets a new
tenant-qualified root first, verifies the archive and tree, records an audit
event, and only then performs an explicit switch or rollback.

Wanghai's standalone scripts remain standalone-only. The Polaris adapter does
not expose an integrated shell command or allow a caller to choose an
arbitrary restore path.

### Quotas, resources, and observability

Use a logical Polaris quota ledger for active workspace, cache, runtime state,
and identity state. Reserve the estimated write before forwarding and reconcile
actual usage after completion. The Docker release host additionally needs a
real per-vault filesystem or volume ceiling; a directory size setting alone is
not enforcement on overlay2/ext4.

Start with the measured candidate of 256Mi active workspace, 64Mi cache,
128Mi runtime state, and 64Mi identity state per active user, with encrypted
backups outside the hot workspace volume. Reject a reservation atomically when
the logical or physical ceiling is exceeded.

Expose structured lifecycle, gateway, job, quota, resource, and backup events
with tenant-safe identifiers. Add counters/gauges for active tenants, gateway
decisions, queue depth, job age/retries, quota utilization, CPU/memory/disk
pressure, and recovery failures. Alert before exhaustion; never log bodies,
credentials, assertions, or customer identifiers.

### Promotion and evidence

A release candidate is a manifest containing Polaris, workspace-base, Wanghai
image digests, migration version, quota/resource profile, and evidence
references. CI or the promotion command verifies digest pinning, SBOM,
provenance, and signatures before traffic changes. One deployment lock permits
one promotion; rollback selects the previous verified manifest.

The release evidence document records external DNS/TLS, two synthetic tenants,
5/10-user tests, resource/quota enforcement, restart recovery, backup/restore,
dependency triage, and promotion artifacts separately from unit-test results.

## Risks / Trade-offs

- [Single-host SQLite] -> No replicas are permitted; backup and restore become
  mandatory recovery controls, and a later multi-host release must replace the
  adapter with a network transactional store.
- [Generic Wanghai routes are not all semantically versioned] -> Use an explicit
  action catalog and fail closed for unknown mutations.
- [Filesystem quotas differ by backend] -> Treat the Docker host filesystem or
  volume ceiling as a release prerequisite and keep the logical ledger as the
  cross-backend product contract.
- [External signing, DNS, and backup storage need operator credentials] ->
  Keep code checks fail closed and record missing external proof as no-go rather
  than substituting fixtures.
- [A bounded ten-user profile may reject bursts] -> Queue or return capacity
  errors deterministically and expose the queue/resource reason to operators.

## Migration Plan

1. Preserve and test the existing uncommitted migration/preflight slice as a
   separate reviewed batch.
2. Add the semantic write and job contracts behind fail-closed feature gates.
3. Migrate synthetic data with the manifest-driven tool, verify it, and run an
   encrypted backup before any live data cutover.
4. Provision the single-host release profile, private `/wanghai/` ingress, hard
   per-vault storage ceilings, metrics, and signed candidate images.
5. Run perimeter, two-tenant, restart, backup/restore, and 2/5/10-user evidence
   in order. Promote only if every required table is complete.
6. Roll back by selecting the previous signed manifest and preserving the
   original tenant roots.

## Open Questions

- Which production registry and signing key service will provide the Wanghai
  and Polaris attestations?
- Which backup destination and key-management boundary will be used on the
  release host?
- Does the release host support project quotas, a bounded volume driver, or
  another hard per-vault storage mechanism?
- Which exact Wanghai mutation routes are needed for the initial user cohort?
  Any route not selected is intentionally unavailable in integrated mode.
