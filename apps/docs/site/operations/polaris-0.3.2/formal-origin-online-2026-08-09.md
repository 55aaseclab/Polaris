# Polaris 0.3.2 Formal Origin Online Evidence

Date: 2026-08-09 UTC

Status: **partial perimeter evidence**. These checks validate the public
origin and unauthenticated security boundary. They do not close clean-host
attestation verification, the authenticated tenant matrix, rollback, or
production approval.

## Target

```text
https://polaris.jianxiaoyitech.com
```

The remote candidate was `0.3.1` at the time of this observation, with the
green blue/green stack active. The release candidate is subsequently bumped to
`0.3.2`; this record is intentionally timestamped so the observation is not
confused with post-bump evidence.

## Checks

| Check | Result |
| --- | --- |
| DNS A resolution | `polaris.jianxiaoyitech.com -> 152.32.170.198` |
| HTTP to HTTPS | `301` to `https://polaris.jianxiaoyitech.com/` |
| HTTPS Portal | `200` |
| `/healthz` | `200`, `{"service":"polaris-portal","status":"ok"}` |
| `/readyz` | `200`, `{"service":"polaris-portal","status":"ready"}` |
| `/paseo/` | `200`, Paseo HTML served |
| Paseo manifest and metadata | `200` |
| `/v/<synthetic>/coding` Portal route | `200`, Portal document served |
| `/paseo/h/<synthetic>` | `200`, Paseo document served |
| Unauthenticated `/api/session` | `401`, authentication required |
| Unauthenticated `/api/polaris-hosts` | `401`, authentication required |
| Spoofed forwarded-user headers | `401`, no session granted |
| `private-surface.jianxiaoyitech.com` DNS | no address returned by verifier |
| Public Docker `9090` mapping | none; Paseo app ports bind to loopback |

The deployed Paseo bundle was:

```text
index-6b2f155a59678d880a557c732c16c0ce.js
SHA256 4f3652f2932ebc1928793cee1e8bde501297db425b044d40ab1c3bfa272d92dd
```

## TLS Observation

The certificate validated for the formal origin and contained
`polaris.jianxiaoyitech.com` in its SAN set. The observed certificate window
was 2026-06-26 through 2027-01-11. Its subject CN was
`private-surface.jianxiaoyitech.com`; dedicated-origin certificate policy and expiry
monitoring still need an explicit production decision.

The response CSP currently observed was:

```text
content-security-policy: upgrade-insecure-requests
```

Explicit `frame-ancestors`, secure-cookie behavior for an authenticated
session, and the complete Authing browser flow require an authenticated
browser check and remain open.

## Remaining Evidence

- Install or invoke the approved Cosign tool on the designated clean host and
  verify the exact image signature, SLSA provenance, and SPDX attestation.
- Run the two-live-tenant matrix with real Authing-backed browser sessions.
- Exercise rollback after a failed candidate promotion without changing the
  active data root.
- Record the operator, security reviewer, approver, and final go/no-go owner.
