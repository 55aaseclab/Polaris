# Polaris 0.3.3

Status: **archived historical release**, released 2026-08-09. Supported
concurrent active vaults on the single-host profile: **20**.

The 0.3.3 evidence, migration, and ship records are closed historical
artifacts. Do not append new work here. The active release line is
[Polaris 0.3.4](../polaris-0.3.4/), which inherits this release's 20-vault
capacity and resource baseline.

This release raises the controlled user/vault ceiling and ships the measured
resource baseline. Later 50/100 stages remain experiments, not commitments.

## Scope

- Raise `maxActiveVaults` from 10 to 20 in the shared
  `0.3.0-single-host` capacity profile as release identity `0.3.3`.
- Deploy on the EPFL HTTP test host and the formal origin.
- Keep Authing required on production; allow disabled auth only under
  `local-test` on the EPFL bring-up path.
- Publish host minimums for memory, CPU, storage, and Docker networks.

## Plan And Evidence

- [User growth and capacity plan](./user-growth-and-capacity-plan.md)
- [Test-host bring-up and open questions](./test-host-bringup.md)
- [Concurrent capacity evidence 2026-08-09](./concurrent-capacity-evidence-2026-08-09.md)
- [Test-host smoke 2026-08-09](./test-host-smoke-2026-08-09.md)
- [EPFL verify 2026-08-09](./epfl-verify-2026-08-09.md)
- [Twenty-user resource baseline](./twenty-user-resource-baseline.md)
- [Release 0.3.3 ship record](./release-ship-2026-08-09.md)
- [Post-release control/vault-data cutover](./post-release-control-vault-data-2026-08-10.md)

## Release Decisions

| Item | Decision |
| --- | --- |
| Supported ceiling | **20** concurrent active vaults |
| Capacity profile id | `0.3.0-single-host` (profile id ≠ release id) |
| Release identity | `POLARIS_RELEASE_ID=0.3.3` |
| EPFL test host | deployed; Authing may be disabled for lab tests |
| Formal origin | bumped to `0.3.3` with Authing required |
| Creator-destroys | synthetic users, containers, volumes, **and networks** |

## Still Deferred (not blocking this ship)

- Full 20 hot-vault soak after Docker address-pool reconfiguration on a
  ≥32 GiB host.
- Authenticated multi-identity load matrix.
- 50/100 user stages and alert-threshold campaign.
- Residual 0.3.2 items (browser tenant matrix, SPDX clean-host leaf path,
  human security go/no-go).
