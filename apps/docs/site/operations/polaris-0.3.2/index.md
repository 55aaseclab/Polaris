# Polaris 0.3.2

Status: **archived historical release record**. The candidate was deployed as
`0.3.2`. The signed-artifact sub-gate and local
scoped-coding regression are complete; public online evidence is partial.
Clean-host verification, authenticated external release evidence, rollback, and
approval remain open. This release does not raise the supported user count or
make a capacity claim.

The 0.3.2 records are closed historical evidence. Current work continues in
[Polaris 0.3.4](../polaris-0.3.4/).

## Scope

- Signed immutable images with provenance, SBOM, and verification.
- The single formal `polaris.jianxiaoyitech.com` DNS and HTTPS/TLS origin.
- External authenticated release evidence and production approval.

## Plan

- [Production perimeter plan](./production-perimeter-plan.md)
- [Signed image evidence](./signed-image-evidence-2026-08-06.md)

## Current Evidence

The Polaris workspace base and private surface artifacts were built from exact commits,
published by GitHub Actions, and verified with Cosign. This closes only the
0.3.2 supply-chain sub-gate; it is not formal production approval.

The formal-origin probes are recorded in
[online origin evidence](./formal-origin-online-2026-08-09.md). They confirm
DNS, HTTP-to-HTTPS, liveness/readiness, Paseo serving, and the unauthenticated
API boundary. They do not replace an authenticated tenant matrix.

The post-bump candidate checks are recorded in
[post-bump online evidence](./formal-origin-post-bump-online-2026-08-09.md).
A later certificate and unauthenticated perimeter re-check is recorded in
[formal TLS re-check 2026-08-09](./formal-tls-and-perimeter-2026-08-09.md).
A formal-host blue/green traffic rollback round-trip is recorded in
[formal rollback drill 2026-08-09](./formal-rollback-drill-2026-08-09.md).
The focused two-vault coding regression is summarized in
[Infamous Regression](../infamous-regression.md).

## Dependency

Use the 0.3.1 performance report as a regression guard, but do not merge its
performance work into this release. User-scale capacity work begins in
[Polaris 0.3.3](../polaris-0.3.3/) after this perimeter is complete. A passing
performance result does not close a 0.3.2 trust, perimeter, or production gate.

## Exit Rule

Close 0.3.2 only when every checklist item in the plan has named evidence,
rollback coverage, and an explicit production decision.
