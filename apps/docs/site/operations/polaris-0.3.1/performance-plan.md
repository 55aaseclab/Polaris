# Polaris 0.3.1 Performance Plan

Status: released on 2026-08-06 for the measured gateway and Portal host-list
paths within the existing controlled test-host envelope.

## Objective

Improve the latency, throughput, and predictability of the existing Polaris
request paths without changing the supported user count, storage allocation,
or active-vault admission policy.

This release establishes performance measurements and regression guards. It
does not turn a benchmark result into a scale claim.

## Fixed Envelope

Use the current controlled 0.3.0 profile as a fixed test envelope. Preserve
its gateway policy, tenant isolation, durable-job behavior, resource limits,
and data layout while measuring a representative synthetic fixture.

Do not add a larger load stage, change a storage budget, or increase an
admission limit under this plan. Those changes belong to the 0.3.3 capacity
plan and require their own evidence.

## Performance Workstreams

1. Capture reproducible before/after timings for gateway launch, portal
   navigation, host lists, workspace reads, and bounded mutations.
2. Profile the Polaris server, control store, gateway proxy, portal startup,
   and worker paths to identify CPU, I/O, serialization, and lock hot spots.
3. Remove avoidable synchronous work and duplicate requests while preserving
   authorization, idempotency, audit, and tenant checks.
4. Add focused regression tests and measurements for the critical paths so a
   later change cannot silently reintroduce a known slowdown.
5. Verify that slow or unavailable downstream services fail within the existing
   timeout and recovery contracts rather than consuming unbounded work.

## Measurement Contract

Freeze one synthetic fixture, one environment fingerprint, and one command
sequence before collecting results. Record P50, P95, P99, request count,
error count, CPU, memory, event-loop delay, and the relevant trace or profile
for each run. Repeat each measurement at least three times.

Compare the same request shapes before and after a change. Do not compare runs
with different data sizes, authentication modes, active-vault counts, or host
resource allocations.

## Acceptance Criteria

- The critical-path baseline and post-change results are reproducible.
- Each accepted optimization has a measured improvement or prevents a measured
  regression; unmeasured refactors do not close this plan.
- No performance change weakens authorization, tenant isolation, idempotency,
  durable-job recovery, or gateway admission.
- The existing release envelope remains healthy through the measured scenarios.
- The report explicitly states that it makes no higher-user-count or storage
  capacity claim.

## Execution Checklist

- [x] Freeze the first gateway fixture, command sequence, environment
  fingerprint, and metric schema. See the [gateway evidence](./gateway-performance-evidence-2026-08-06.md).
- [x] Record the before/after gateway launch and authenticated read baseline
  for the first accepted change.
- [x] Identify and prioritize the full-vault summary lookup as a measurable
  gateway-path bottleneck.
- [x] Implement and measure the target-vault lookup improvement in a small
  batch.
- [x] Add repeatable benchmark and gateway regression coverage for the
  accepted improvement.
- [x] Capture a paired baseline and candidate measurement for the Portal
  host-list path and remove its measured static-asset hot path.
- [x] Capture profiles for the remaining worker, control-store, and
  bounded-mutation paths. See the [control-plane profiling evidence](./control-plane-performance-evidence-2026-08-06.md).
- [x] Re-run the released fixed-fixture measurements after the final accepted
  change. See the paired host-list evidence.
- [x] Publish the 0.3.1 performance decision and link reproducible evidence.
  See the [release index](./index.md) and its deployment record.

## Evidence

Keep fixture checksums, command versions, environment fingerprints,
before/after tables, profiles, traces, and regression results in a separate
0.3.1 evidence register. User-scale, storage, quota, and capacity evidence
belongs to [Polaris 0.3.3](../polaris-0.3.3/).
