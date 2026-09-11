# Polaris 0.3.3 EPFL Verify: 2026-08-09

Status: **test-host verification under disabled Authing**. User data on the
EPFL host was not deleted. Formal-origin certificate work is separate.

## Host Policy

| Host | Role |
| --- | --- |
| `root@m00e04c1b76c0.dyn.epfl.ch` | Deploy, capacity, functional tests; Authing may be disabled |
| `root@polaris.jianxiaoyitech.com` | Certificate / formal HTTPS only |

## Deployed Identity

```text
active color: green
release: 0.3.3
max active vaults: 20
auth mode: disabled (intentional for test-host bring-up)
source commit: 11bcd9e
data root size: 3568777 bytes (unchanged across rollback drill)
user profile dirs: 3
```

## Checks Completed

| Check | Result |
| --- | --- |
| Health / ready | `200` |
| Disabled-auth `/api/session` | `200`, local development session |
| Host list | `200`, 2 existing hosts (`coding-vertical`, `test-coding`) |
| No public `9090` | confirmed |
| Resource headroom | ~11 Gi available RAM; docker-root 40 Gi free |
| Blue/green rollback drill | green → blue → green; health stayed `200`; data bytes unchanged |
| Local concurrent 20-user bench | pass; read P95 94.98 ms; launch 100%; 0 errors |
| Active-vault unit tests (20 admit / 21 reject) | 5/5 pass |
| Release profile + preflight unit tests | 28/28 pass |
| Polaris shared-contract unit tests | 33/33 pass |

## Authing Policy On EPFL

Authing is **disabled on purpose** for EPFL so capacity and functional paths
can run without browser login. Color-specific env files
(`polaris-server-blue.env` / `polaris-server-green.env`) override
`polaris.env` and must be kept in sync when flipping the mode.

Formal origin keeps `authing-browser-session`.

## Still Open

- Twenty simultaneously hot Docker vaults on EPFL (memory budget is tight).
- Authenticated multi-identity load (needs Authing or synthetic oauth2-proxy
  fixture on a disposable path; not required while EPFL stays disabled-auth).
- 50/100 user stages.
- Production go/no-go (blocked on 0.3.2 perimeter items as well).

## Artifacts

```text
site/public/release-evidence/0.3.3-20260809-epfl-verify/
```
