# Gateway Performance Evidence: 2026-08-06

Status: first accepted Polaris 0.3.1 optimization. This is a local synthetic
control-plane result, not production, browser, Authing, storage, or capacity
evidence.

## Change

Baseline commit: `9584d27`.

Candidate commits:

- `a9aa260 perf(gateway): avoid full vault summary lookup`
- `b23b2fb test(benchmark): record gateway resource signals`

Each gateway launch and authenticated `/g/*` read previously constructed every
owned vault summary, which parsed each vault status and selected runtime YAML
before finding the requested opaque private surface ID. The candidate enumerates owned
vault names, resolves the opaque ID, then reads only the selected vault status
and selected runtime configuration. It still validates the current user, the
selected runtime, and the private surface surface on every request; it does not fall
back to a retained runtime.

## Fixture

- Three serial baseline runs followed immediately by three serial candidate
  runs.
- `10` synthetic vaults, `20` warmups, and `150` measured samples per run.
- Node `v22.23.1`, Linux `6.12.74+deb13+1-amd64`.
- The benchmark creates a disposable `POLARIS_DATA_ROOT`, local control store,
  loopback portal, and fake private surface upstream in a child process, then removes
  them. It does not start Docker or contact the test host.
- Portal authentication is disabled only to inject one synthetic mapped user;
  the measured launch still creates a gateway ticket and the measured read uses
  the resulting scoped gateway cookie.

Current candidate command:

```sh
pnpm --filter polaris run benchmark:gateway -- \
  --vaults 10 --samples 150 --warmup-samples 20
```

The resource figures cover each measured 150-sample loop. Event-loop delay uses
Node's `monitorEventLoopDelay` with a `10 ms` resolution. CPU and RSS are
process-level signals, not per-request limits.

## Median Results

Values are the median of the three per-run percentile summaries, in
milliseconds unless stated otherwise.

| Operation | Baseline P50 | Candidate P50 | Baseline P95 | Candidate P95 | P95 change |
| --- | ---: | ---: | ---: | ---: | ---: |
| Host list | 5.06 | 5.22 | 5.66 | 7.26 | Not targeted |
| Gateway launch | 5.17 | 1.79 | 5.81 | 2.17 | -62.7% |
| Gateway ticket exchange | 1.62 | 1.56 | 1.76 | 1.79 | No material change |
| Authenticated gateway read | 6.68 | 3.25 | 7.68 | 3.89 | -49.3% |

| Process signal | Baseline median | Candidate median | Change |
| --- | ---: | ---: | ---: |
| User CPU time | 2065.43 ms | 1143.64 ms | -44.6% |
| System CPU time | 240.88 ms | 120.36 ms | -50.0% |
| Peak RSS | 164892672 bytes | 166780928 bytes | +1.1% |
| Event-loop delay P95 | 12.98 ms | 13.11 ms | No material change |

All six runs completed with `0` recorded errors for host list, launch, ticket
exchange, and gateway read. Host-list P50 stayed near `5 ms`; its P95 is not a
claim of regression or improvement because that endpoint is not changed and
the isolated host exhibited scheduling variation.

## Raw Evidence

The JSON records are immutable input to the table above:

| Baseline (`9584d27`) | Candidate (`b23b2fb`) |
| --- | --- |
| [Run 1](/release-evidence/0.3.1-20260806-gateway-performance/baseline-9584d27-run-1.json) | [Run 1](/release-evidence/0.3.1-20260806-gateway-performance/candidate-b23b2fb-run-1.json) |
| [Run 2](/release-evidence/0.3.1-20260806-gateway-performance/baseline-9584d27-run-2.json) | [Run 2](/release-evidence/0.3.1-20260806-gateway-performance/candidate-b23b2fb-run-2.json) |
| [Run 3](/release-evidence/0.3.1-20260806-gateway-performance/baseline-9584d27-run-3.json) | [Run 3](/release-evidence/0.3.1-20260806-gateway-performance/candidate-b23b2fb-run-3.json) |

SHA-256 checksums, in table order:

```text
d1632112b0b388f9898b085c02cc40ced31a03fb9c9ffdfc616f8ed3cd9ce26e
8fb317d72a0ec91580d25cde0f7bffc4618a37c3e4eb3e9ea1b92a8742209762
398d2d426d067fed5ebf4d7881fb5f0f8281051735e5f6855328392aa595589e
c099ce22dcef264a09263d18fb26ffb1ac69f4303949f26adcf4d0002e4ad3f4
9ef77e4b128eb6b95c215536a8e6dc8016aa80f58b2ab76d8e8f14b717a06f97
c6f8a552529b11d4eccd2d140fc32f6563e41eaf0da9433f5adac3eea2975397
```

## Decision

Accept the target-vault lookup optimization as the first 0.3.1 performance
improvement. It materially improves the interactive private surface launch and first
authenticated read without weakening the gateway's tenant, selected-runtime,
or surface checks.

Do not use this evidence to raise the controlled user ceiling, adjust storage
budgets, approve formal production ingress, or claim real-user browser
latency. Those decisions remain outside 0.3.1 as defined by the release plan.
