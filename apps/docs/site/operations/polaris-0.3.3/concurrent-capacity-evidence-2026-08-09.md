# Concurrent User Capacity Evidence: 2026-08-09

Status: local synthetic multi-user control-plane evidence for the 0.3.3
20-user candidate. This is not production, Authing-browser, Docker-hot-vault,
or formal-origin evidence.

## Why This Exists

Raising `maxActiveVaults` from 10 to 20 is only a profile claim until a
multi-user concurrent path is measured. The single-user multi-vault gateway
benchmark is not enough: it lists many vaults for one identity. The 0.3.0
10-user capacity run used concurrent synthetic identities; 0.3.3 needs the
same shape at 20.

## Change Under Test

- Profile `maxActiveVaults` raised to 20.
- New isolated benchmark:
  `pnpm --filter polaris run benchmark:concurrent-users`.
- Unit coverage for the 20th admit / 21st reject active-vault gate.

## Fixture

- Disposable `POLARIS_DATA_ROOT` under the workspace temp root (not `/tmp`
  tmpfs; concurrent fixtures create many small files).
- `oauth2-proxy` auth with distinct forwarded usernames and user-map entries.
- One synthetic vault per user, already marked running, with a shared fake
  private surface upstream on loopback.
- Measured path per user per round: session, host list, gateway launch,
  ticket exchange, authenticated gateway read.
- All users in a round run concurrently via `Promise.all`.

Commands:

```sh
pnpm --filter polaris run benchmark:concurrent-users -- \
  --users 10 --rounds 3 --warmup-rounds 1
pnpm --filter polaris run benchmark:concurrent-users -- \
  --users 20 --rounds 3 --warmup-rounds 1
```

## Results

| Users | Rounds | Launch success | Read P95 (max op) | Errors | Pass vs profile SLO |
| ---: | ---: | ---: | ---: | ---: | --- |
| 10 | 3 | 100% | 27.49 ms | 0 | yes |
| 20 | 3 | 100% | 74.39 ms | 0 | yes |

Profile SLO used: launch success >= 99.5%, read P95 <= 500 ms, 5xx <= 1%.

At 20 concurrent users the slowest measured read-category P95 was gateway
read at 74.39 ms. Host-list P95 rose from the 10-user run but stayed well
below the 500 ms budget.

## Raw Evidence

| Run | Artifact |
| --- | --- |
| 10 concurrent users | [concurrent-10.json](/release-evidence/0.3.3-20260809-concurrent-capacity/concurrent-10.json) |
| 20 concurrent users | [concurrent-20.json](/release-evidence/0.3.3-20260809-concurrent-capacity/concurrent-20.json) |

## What This Does Not Prove

- Twenty simultaneously hot Docker private surface containers on the test host.
- Real Authing browser sessions or formal HTTPS origin behavior.
- Storage-category quotas, backup pressure, or noisy-neighbor disk exhaustion.
- Production go/no-go.

Those remain open 0.3.3 gates after the test-host deploy smoke.
