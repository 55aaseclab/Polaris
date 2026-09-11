# Polaris 0.3.2 Formal TLS And Perimeter Re-Check

Date: 2026-08-09 UTC

Status: **certificate and unauthenticated perimeter evidence**. No deploy and
no data access on the formal host. Browser Authing completion, clean-host
Cosign re-verify, and production approval remain open.

## Scope Rule

`root@polaris.jianxiaoyitech.com` is used only for certificate / formal-origin
checks. Routine deploy and capacity work stay on the EPFL HTTP test host.

## TLS Certificate

| Field | Value |
| --- | --- |
| DNS A | `polaris.jianxiaoyitech.com -> 152.32.170.198` |
| notBefore | 2026-06-26 08:00:00 GMT |
| notAfter | 2027-01-11 07:59:59 GMT |
| Days remaining (as of check) | 154 |
| Subject CN | `private-surface.jianxiaoyitech.com` |
| SAN | `private-surface.jianxiaoyitech.com`, `polaris.jianxiaoyitech.com` |
| Issuer | XinNet DV TLS RSA CA 2025 |

HTTP root returns `301` to `https://polaris.jianxiaoyitech.com/`.

## Unauthenticated HTTPS Probes

| Check | Result |
| --- | --- |
| `/healthz` | `200` |
| `/readyz` | `200` |
| `/paseo/` | `200` |
| `/paseo/metadata.json` | `200` |
| `/api/session` | `401` |
| `/api/polaris-hosts` | `401` |
| `/api/authing-config` | `200`, `authMode=authing-browser-session`, formal redirect URI |
| Spoofed `X-Auth-Request-User` | `401` |
| Public `9090` / `8787` / app ports | closed from external probe |

Observed CSP on the Portal response:

```text
content-security-policy: upgrade-insecure-requests
```

There is still no explicit `frame-ancestors` policy in this response set.
Secure authenticated cookie behavior still needs a real browser session.

## Cosign Clean Verification Attempt

A local Cosign `v2.4.3` re-check of the published digests reported **no
signatures or attestations** currently retrievable from GHCR for:

- `ghcr.io/jianxiaoyitech/private-surface@sha256:b1a31a8576a101a922e31d9d0634a60087f4d7e5ee349af0b0c28079a6030f72`
- platform manifest `sha256:39d52fe68fc9963028474b66396e9975e81f05b1d55243c30a45c765efdd1f59`
- `ghcr.io/jianxiaoyitech/polaris-workspace-base@sha256:dafa22943cdb75e41662f46130910b2c4602c568b2159f2c4483450040748eb7`

This does **not** close the clean-host supply-chain gate. The earlier
2026-08-06 signed-image evidence remains the historical pass record; a fresh
clean-host verify must succeed again before production promotion.

## Still Open For 0.3.2

- Clean-host Cosign / provenance / SPDX policy as a single production preflight
  path (signature + provenance re-verified with cosign v3 + GHCR auth; SPDX
  leaf-certificate path still fails).
- Authenticated two-tenant browser matrix on the formal origin.
- Explicit CSP `frame-ancestors` and authenticated secure-cookie proof.
- Security review and go/no-go owner.

Traffic rollback on this host is recorded separately in
[formal rollback drill](./formal-rollback-drill-2026-08-09.md).

## Artifacts

Raw probe outputs:

```text
site/public/release-evidence/0.3.2-20260809-formal-tls/
```
