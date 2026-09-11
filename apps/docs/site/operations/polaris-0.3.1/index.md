# Polaris 0.3.1

Status: **archived historical release**, released to the designated HTTP test
host on 2026-08-06. This release
contains two fixed-envelope request-path optimizations with reproducible
before/after evidence.

The 0.3.1 records are closed historical evidence. Current work continues in
[Polaris 0.3.4](../polaris-0.3.4/).

This release is intentionally narrow. It improves latency, throughput, and
predictability inside the existing controlled test-host profile. It does not
raise the supported user count, revise storage allocation, or make a capacity
claim.

## Scope

- Gateway launch/read and Portal host-list latency in the fixed 10-vault
  fixture.
- Removal of measured duplicate work while preserving authorization,
  idempotency, audit, and tenant checks.
- Repeatable fixtures and regression coverage for the released paths within
  the existing envelope.
- Correct degraded behavior while preserving tenant isolation, durable jobs,
  and the Polaris-owned private surface gateway boundary.

## Not In Scope

- User-count growth, load-stage expansion, or a new supported-user ceiling.
- Storage budgets, logical quota expansion, eviction policy, and host-capacity
  allocation.
- Resource-envelope changes intended to admit more active vaults.

Those concerns belong to [Polaris 0.3.3](../polaris-0.3.3/), after the 0.3.1
performance guardrails and 0.3.2 production perimeter are complete.

## Plan

- [Performance plan](./performance-plan.md)
- [Gateway performance evidence, 2026-08-06](./gateway-performance-evidence-2026-08-06.md)
- [Host-list performance evidence, 2026-08-06](./host-list-performance-evidence-2026-08-06.md)
- [Control-plane profiling evidence, 2026-08-06](./control-plane-performance-evidence-2026-08-06.md)
- [0.3.1 test-host deployment evidence](/release-evidence/0.3-20260806-polaris-0.3.1-release.json)

## Current Evidence

The first accepted change removes unnecessary full-vault summary loading from
the private surface gateway path. Under a fixed local 10-vault fixture, its median
gateway-launch P95 fell from `5.81 ms` to `2.17 ms` and its authenticated
gateway-read P95 fell from `7.68 ms` to `3.89 ms`.

The second accepted change removes per-vault static-asset reconstruction from
the Portal host list while retaining selected-runtime validation and the full
detail path. In alternating 10-vault runs, host-list P95 fell from `7.05 ms`
to `4.32 ms`. Both records are local synthetic control-plane measurements only;
they do not change the user ceiling, storage allocation, or production-readiness
decision.

The post-release profiling record covers the remaining worker, control-store,
and bounded-mutation paths. It accepts one measured worker improvement:
skipping a duplicate status synthesis for provisions that do not start a
vault. The worker P95 fell from `37.50 ms` to `24.48 ms` in the fixed fixture.
The control-store and bounded-mutation profiles are regression evidence only;
they do not carry an additional optimization or capacity claim.

## Release Decision

Polaris source `320e949` was deployed through the test-host blue/green path
with a `0.3.1` manifest chained to the prior `0.3.0` manifest. The active
blue deployment passed release preflight, public root/host/health/readiness
checks, the unauthenticated gateway boundary, legacy route removal, Paseo
serving, and the private `9090` check.

This releases the two deployed request-path improvements only. The later
profiling record closes the 0.3.1 performance-plan gate for worker,
control-store, and bounded-mutation observation, but commit `64b0b51` has not
been promoted to the designated test host by this record. This release makes
no capacity, storage, formal TLS/DNS, signed-image, or authenticated-browser
claim.

## Explicitly Deferred

The following are planned for [Polaris 0.3.2](../polaris-0.3.2/), not this
release:

- signed images, provenance, SBOM, and Cosign verification;
- formal `polaris.jianxiaoyitech.com` DNS and HTTPS/TLS;
- external production release evidence and approval.

User-scale capacity, storage, and resource-envelope work is planned for
[Polaris 0.3.3](../polaris-0.3.3/), not 0.3.1.

## Exit Rule

0.3.1 is closed for its two deployed paths and its documented profiling gate.
It must not be used as evidence of a higher user ceiling, a storage decision,
or 0.3.2 production readiness.
