# Polaris 0.3.2 Post-Bump Online Evidence

Date: 2026-08-09 UTC

Status: **candidate perimeter evidence**. This is evidence for the deployed
`0.3.2` candidate, not formal production approval. Clean-host attestation
verification, the authenticated tenant matrix, rollback, security review, and
go/no-go approval remain open.

## Target And Release Identity

```text
https://polaris.jianxiaoyitech.com
source commit: 1ff5f0d4e6def0d272f277107147a900580f6da4
release: 0.3.2
active color: blue
public upstream: 127.0.0.1:18080
release manifest sha256: 379564dcc39d6cfbf4364e1db6dc1fd2d83a0a9596ed693c68535a9c76e670fd
environment sha256: b7cc97dc19e9a30c8c8d32c0bd929414caa4c78ea5517fa2df80645404f93e9b
```

The remote manifest and `/etc/polaris/polaris.env` match the local candidate.
The previous `green` stack remains running with the prior release identity as
a rollback candidate; a rollback drill has not been performed.

## External Checks

| Check | Result |
| --- | --- |
| DNS A resolution | `polaris.jianxiaoyitech.com -> 152.32.170.198` |
| HTTP to HTTPS | `301` to the HTTPS origin |
| HTTPS Portal | `200` |
| `/healthz` | `200`, JSON liveness response |
| `/readyz` | `200`, JSON readiness response |
| `/paseo/` | `200`, Paseo HTML served |
| `/paseo/metadata.json` | `200` |
| `/v/<serverId>/coding` | `200`, Portal document served for two synthetic IDs |
| `/paseo/h/<serverId>` | `200`, Paseo document served for two synthetic IDs |
| `/api/authing-config` | `200`, Authing mode and formal-origin redirect URI returned |
| Unauthenticated `/api/session` | `401` |
| Unauthenticated `/api/polaris-hosts` and `/api/polaris-hosts/test` | `401` |
| Spoofed forwarded-user headers | `401`, no session granted |
| Public raw `9090` and `8787` | no connection; remote app ports are loopback-only |

The two route probes used distinct IDs (`srv_DOqwdgEYDOCd` and
`srv_5pE3JR0GQQ1P`) and scope query variants. Both remained Portal routes; no
route was redirected to `/settings/general` by the gateway probe.

## Artifact And Service Checks

The deployed Paseo bundle is:

```text
index-6b2f155a59678d880a557c732c16c0ce.js
SHA256 4f3652f2932ebc1928793cee1e8bde501297db425b044d40ab1c3bfa272d92dd
```

`polaris-server@blue.service`, the blue Paseo app, and blue Nginx are running.
The blue Paseo container image ID is
`sha256:851963c5a7a7b1fcf9b928d8771cb2c08ce5af4f1142ab6b2266d09fc9d9a574`.

## Regression Check

The app-specific focused suite passed:

```text
5 test files passed
122 tests passed
```

It includes the two-vault scoped coding regression, scope normalization,
server-ID filtering, runtime client lifetime, and settings-fallback guards.
The named case and its reproduction method are documented in
[Infamous Regression](../infamous-regression.md).

## Open Gates

- Run Cosign signature, SLSA provenance, and SPDX policy verification on the
  designated clean host.
- Run the authenticated two-tenant browser matrix through this origin.
- Verify secure authenticated cookies, explicit CSP/frame-ancestor policy,
  Authing browser completion, gateway mutations, and backup/restore behavior.
- Perform a failed-promotion rollback drill and record the rollback owner.
- Record security review and the production go/no-go decision.
