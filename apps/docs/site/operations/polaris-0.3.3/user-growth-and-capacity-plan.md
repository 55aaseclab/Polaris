# Polaris 0.3.3 User Growth And Capacity Plan

Status: active candidate. This plan owns user-count expansion, storage
capacity, and the measured supported-user ceiling. The first ship target is
**20 concurrent active vaults**. Later stages stay experiments until measured.

## Objective

Raise the active-user boundary while keeping private surface a vault-scoped Polaris
surface. Set the smallest practical storage and resource budgets, enforce them
at the relevant layer, then grow the active-user count through measured stages.

The order is deliberate: start with the fixed 0.3.1 performance baseline,
reuse the 0.3.2 perimeter where available, measure storage and resource use on
the designated test host, and only then admit the next user stage.

## Candidate Storage Budget

The initial per-active-vault hot-storage budget is **512Mi**, not a 1Gi user
entitlement. It is a candidate budget until the measurement corpus proves that
a smaller or larger value is required.

| Category | Logical cap | Policy |
| --- | ---: | --- |
| Active workspace data | 256Mi | Polaris reservation and hard filesystem ceiling |
| Evictable cache | 64Mi | LRU eviction; never durable user data |
| Runtime state | 128Mi | Polaris-owned fixed cap |
| User identity state | 64Mi | Shared user budget; do not multiply by vault count |
| Hot backup copy | 0Mi target | Encrypted backups live outside the active volume |

Keep the current physical request only while representative measurement and
hard quota enforcement are incomplete. At the candidate budget, 20 active
vaults need about 10Gi hot storage before platform overhead. Image layers,
logs, shared caches, backups, and staging volumes need separate capacity
pools.

If local backup is unavoidable, allocate a separate enforced 256Mi backup
budget and retain at most two snapshots. Never consume workspace capacity for
backups silently.

## Measurement Corpus

Build a synthetic corpus containing empty workspaces, 10/25/50 product and
order records, and 1/5/10 uploads at 1MiB, 5MiB, and 25MiB. Include two
concurrent writers and one backup/restore cycle. For each corpus, record
logical bytes by category, physical bytes, inode count, P50/P95/P99 latency,
queue depth, and peak memory three times.

The candidate active-workspace quota is:

```text
max(256MiB, P99 active bytes * 2, 4 * largest permitted upload)
```

Increase quotas only when the measured P99 requires it. Do not increase every
vault by guesswork.

## Capacity Workstreams

1. Extend Polaris accounting from active workspace data to cache, runtime,
   identity, job staging, and backup categories; enforce each category at the
   filesystem or storage layer.
2. Measure Docker and host overhead independently from the renderer declaration
   so configured limits and enforceable capacity cannot drift apart.
3. Add alerts at 70%, 85%, and 95% for storage, CPU, memory, PIDs, queue depth,
   and error rate, with an admission or rollback response for each threshold.
4. Keep one private surface process per vault while measuring. Do not add gateway or
   worker replicas until their control-store, ticket, rate-limit, audit,
   session, and job state has a shared transactional design.
5. Verify that quota rejection is atomic: no partial write, lost job, or
   cross-tenant read may result from pressure.

## User-Growth Stages

| Stage | Active users | Required focus |
| ---: | ---: | --- |
| A | Current controlled profile baseline (10) | Confirm the 0.3.1 performance baseline and quota correctness |
| B | **20** | First ship target: gateway, job, storage, and host memory under the raised ceiling |
| C | 50 | Target load, noisy-neighbor behavior, and backup pressure |
| D | 100 | Capacity boundary, alerting, admission, and controlled failure |

Every stage uses synthetic data. Stage B may begin with local-test disabled
auth for operator smoke; multi-identity capacity proof still needs distinct
authenticated fixture identities. Exercise launch, portal navigation, file
browsing, uploads, concurrent mutations, durable jobs, backup/restore,
restart, slow providers, network loss, queue pressure, and storage pressure.
Stop at the first stage that cannot meet the acceptance targets; the previous
passing stage becomes the provisional ceiling until a later change is
measured.

## Acceptance Targets

- Launch success >= 99.5%.
- Read API P95 <= 500 ms at 20 and 50 users and <= 750 ms at 100 users.
- Mutation P95 <= 1.5 s excluding external-provider latency.
- 5xx < 1% excluding injected provider failures.
- No cross-tenant access, lost jobs, unreconciled writes, or partial writes
  after a quota rejection.
- Health and readiness recover within 120 seconds after a controlled restart.
- Storage, queue, and resource alerts fire before exhaustion.
- The final report names the supported user ceiling and the reason for any
  lower ceiling than the attempted stage.

## Execution Checklist

- [x] Raise the shared profile `maxActiveVaults` to 20 and bump release
  identity to `0.3.3`.
- [x] Allow disabled auth only in local-test preflight for test-host bring-up.
- [x] Add a concurrent multi-user capacity benchmark and prove the 20th admit /
  21st reject active-vault gate in unit tests.
- [x] Record local concurrent 10- and 20-user gateway evidence
  ([2026-08-09](./concurrent-capacity-evidence-2026-08-09.md)).
- [x] Deploy the candidate to the designated HTTP test host
  ([smoke 2026-08-09](./test-host-smoke-2026-08-09.md)).
- [x] Record health, readiness, disabled-auth session, and no public `9090`
  on the test host.
- [x] Keep EPFL Authing disabled for capacity/functional bring-up; formal
  origin retains Authing. Documented in
  [EPFL verify](./epfl-verify-2026-08-09.md).
- [x] Blue/green rollback drill on EPFL with unchanged data-root size.
- [x] Re-run local concurrent 20-user bench and capacity unit tests after the
  deploy candidate.
- [x] Measure per-vault memory/CPU/storage on 0→4 hot vaults; publish linear
  20-user host baseline
  ([baseline](./twenty-user-resource-baseline.md)).
- [x] Codify creator-destroys test resource ownership on EPFL runs.
- [ ] Run the authenticated multi-identity stage when Authing is intentionally
  re-enabled, or via a disposable synthetic fixture.
- [ ] Reconfigure Docker address pools and soak 20 hot vaults on a host with
  ≥32 GiB RAM when available.
- [ ] Run the 50-user stage only after a full 20 hot-vault soak (or an accepted
  larger-host linear re-measure).
- [ ] Run the 50-user stage only after 20 passes.
- [ ] Run the 100-user boundary stage or document the measured lower ceiling.
- [ ] Review alert thresholds, resource headroom, and admission behavior.
- [x] Publish the capacity decision for 20 concurrent vaults
  ([ship record](./release-ship-2026-08-09.md),
  [resource baseline](./twenty-user-resource-baseline.md)).

## Evidence

Keep corpus checksums, load-generator versions, environment fingerprints,
quota configuration, latency and resource tables, alert records, and failure
reports in a separate 0.3.3 evidence register. Do not append these results to
the 0.3.0 release evidence, the 0.3.1 performance report, or the 0.3.2
production-readiness record.
