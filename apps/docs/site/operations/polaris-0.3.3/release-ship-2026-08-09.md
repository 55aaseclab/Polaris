# Polaris 0.3.3 Ship Record

Date: 2026-08-09 UTC

Status: **shipped**. Operator decision: stop open verification gates and publish
`0.3.3` on local sources, the EPFL test host, and the formal origin.

## Identity

| Field | Value |
| --- | --- |
| Release | `0.3.3` |
| Profile | `0.3.0-single-host` |
| `maxActiveVaults` | 20 |
| Polaris source (ship commit) | `e22e638` (`0.3.3`) |
| Migration label | `release-0.3.3-ship` |

## Surfaces (post-ship)

| Surface | Color | Auth | Release in process | Health |
| --- | --- | --- | --- | --- |
| Local checkout | n/a | n/a | tag `0.3.3`, profile 20 | n/a |
| `m00e04c1b76c0.dyn.epfl.ch` | blue | disabled | `0.3.3` / max 20 | 200 |
| `polaris.jianxiaoyitech.com` | green | `authing-browser-session` | `0.3.3` / max 20 | HTTPS 200; session 401 |

Formal data root fingerprint after ship: `60665657` bytes (unchanged from
pre-ship). EPFL data root left intact; no synthetic leftovers required.

## Evidence Already On File

- Concurrent 20-user control-plane bench
- EPFL smoke, rollback drill (data intact), resource baseline
- Formal TLS probes and formal traffic rollback (pre-ship 0.3.2 path)

## Post-ship Source Review

The runtime extraction was reviewed against Polaris baseline commit `e22e638`
(`0.3.3`). This is implementation-level evidence from the working tree, not
a new deployment or a release-gate closure.

- Moved the reusable Docker, Pod, and KubeVirt execution code to
  `@polaris/vault-runtime` and kept Polaris as the control plane.
- Checked the `VaultSpec` to `VaultRuntimeSpec` projection and retained the
  existing `vaultRuntimeScopeName`, resource names, private gateway boundary,
  and one-vault lifecycle behavior.
- Focused checks passed: vault-runtime build, Polaris typecheck, private surface
  environment and renderer regressions, pairing URL, resource limits, active
  vault capacity, evolution injection, and the default Polaris test group.
- The follow-up self-contained runtime test layer now passes its package
  typecheck and 10/10 runtime contract tests; the workspace full-minus-infra
  command runs these checks before the Polaris default group.
- Batch vault startup and unsupported runtime promotion remain outside this
  change.

## Explicitly Not Closed By This Ship

SPDX clean-host leaf verification, authenticated two-tenant browser matrix,
and a signed human security go/no-go remain open from the 0.3.2 track and do
not block the capacity identity bump.
