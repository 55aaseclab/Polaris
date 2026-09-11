# Polaris 0.3.3 Test-Host Smoke: 2026-08-09

Status: **test-host candidate smoke only**. Auth is disabled under
`local-test`. This is not production approval and does not prove twenty hot
Docker vaults.

## Deployed Identity

```text
host: root@m00e04c1b76c0.dyn.epfl.ch
active color: green
upstream: 127.0.0.1:28080
release: 0.3.3
profile: 0.3.0-single-host
max active vaults: 20
auth mode: disabled
source commit: 11bcd9e753be1727558e0ea8eece16923d23cd7d
manifest migration: release-0.3.3-20-vaults
```

Process environment on `polaris-server@green` matches the host env file for
`POLARIS_RELEASE_ID`, `POLARIS_MAX_ACTIVE_VAULTS`, and `POLARIS_AUTH_MODE`.
Preflight accepted the release profile (`release profile: ok`).

## Checks

| Check | Result |
| --- | --- |
| Green `/healthz` | `200` |
| Green `/readyz` | `200` |
| Public host `/healthz` | `200` |
| Public `/api/session` with auth disabled | `200`, local development session |
| External origin `/healthz` | `200` |
| External `/api/session` | `200`, `authMode=disabled` |
| Public raw `9090` | no listener |
| private surface Docker gateway host | loopback-only path retained |

## Prior Local Evidence

Concurrent multi-user gateway load at 10 and 20 synthetic identities passed
with read P95 27.49 ms and 74.39 ms. See
[concurrent capacity evidence](./concurrent-capacity-evidence-2026-08-09.md).

## Still Open

- EPFL Authing stays **disabled on purpose** for bring-up tests; restore only
  when an authenticated matrix is intentionally scheduled. Formal origin keeps
  Authing.
- Measure twenty simultaneously hot Docker vaults and host memory headroom.
- Formal origin, signed promotion, and go/no-go remain outside this smoke.
  See [EPFL verify](./epfl-verify-2026-08-09.md).
