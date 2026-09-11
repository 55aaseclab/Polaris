# Portal Host-List Performance Evidence: 2026-08-06

Status: second accepted Polaris 0.3.1 optimization. This is local synthetic
control-plane evidence, not production, browser, Authing, storage, or capacity
evidence.

## Change

Baseline commit: `a540d5a`.

Candidate commit: `af3e4fa perf(portal): avoid static asset work in host lists`.

The Portal host list previously loaded each vault's persisted status, rebuilt
its static asset inventory when necessary, checked the inventory's filesystem
paths, and then loaded the selected runtime again to determine its surfaces.
The static inventory belongs to the individual vault detail path, not the host
list. The candidate reads the persisted status and the selected runtime for
each listed vault, while `loadVaultSummary` and the detail path retain their
full asset behavior.

The selected-runtime rule is unchanged: the list still reads the current
selected runtime before advertising private surface or Paseo. The private surface gateway
performs its own selected-runtime and tenant checks on every launch and proxy
request.

## Fixture

- Three alternating serial pairs: baseline, candidate, baseline, candidate,
  baseline, candidate.
- `10` synthetic vaults, `30` warmups, and `400` measured samples per run.
- Node `v22.23.1`, Linux `6.12.74+deb13+1-amd64`.
- The benchmark creates a disposable Polaris data root, control store,
  loopback Portal, and fake private surface upstream in a child process. It does not
  start Docker or contact the test host.
- Portal authentication is disabled only to inject one synthetic mapped user.
  Each run still exercises the host list, private surface launch ticket, ticket
  exchange, and authenticated gateway read.

Command for each run:

```sh
pnpm --filter polaris run benchmark:gateway -- \
  --vaults 10 --samples 400 --warmup-samples 30
```

## Median Results

Values are the median of the three per-run percentile summaries, in
milliseconds unless stated otherwise.

| Operation | Baseline P50 | Candidate P50 | Baseline P95 | Candidate P95 | Baseline P99 | Candidate P99 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Portal host list | 5.02 | 3.45 | 7.05 | 4.32 | 9.77 | 6.58 |
| Gateway launch | 1.74 | 1.75 | 2.04 | 2.18 | 2.51 | 2.68 |
| Gateway ticket exchange | 1.56 | 1.54 | 1.77 | 1.81 | 2.10 | 2.38 |
| Authenticated gateway read | 3.17 | 3.23 | 3.69 | 3.78 | 4.57 | 4.71 |

The targeted host-list path improved by `31.3%` at P50, `38.7%` at P95, and
`32.7%` at P99. Process user CPU fell from `2768.85 ms` to `2262.34 ms`
(`-18.3%`), system CPU fell from `327.46 ms` to `199.41 ms` (`-39.1%`), and
peak RSS fell from `178987008` bytes to `172597248` bytes (`-3.6%`).

All six runs recorded zero errors for host list, launch, ticket exchange, and
gateway read. The non-target gateway measurements are reported for regression
visibility, not as an improvement claim.

## Raw Evidence

The JSON records are immutable input to the table above:

| Pair | Baseline (`a540d5a`) | Candidate (`af3e4fa`) |
| ---: | --- | --- |
| 1 | [Run 1](/release-evidence/0.3.1-20260806-host-list-performance/baseline-a540d5a-run-1.json) | [Run 1](/release-evidence/0.3.1-20260806-host-list-performance/candidate-af3e4fa-run-1.json) |
| 2 | [Run 2](/release-evidence/0.3.1-20260806-host-list-performance/baseline-a540d5a-run-2.json) | [Run 2](/release-evidence/0.3.1-20260806-host-list-performance/candidate-af3e4fa-run-2.json) |
| 3 | [Run 3](/release-evidence/0.3.1-20260806-host-list-performance/baseline-a540d5a-run-3.json) | [Run 3](/release-evidence/0.3.1-20260806-host-list-performance/candidate-af3e4fa-run-3.json) |

SHA-256 checksums, in pair order (baseline then candidate):

```text
143cd81c83d467dee3e5baf0bd3df14d2e66c86784e8d145ccf5c73bbc7e2cf0
58dc4cee8fcd03dde3d20f160cbca09391a3982b469a51525e1ef2c37e435d07
84894872b5189826bc366045ad40e7d4688a0147f17ffc8784f6358582f76178
d05d39e13857962d7b8b35a85cd0c57900b8134b3334f1edb431c4d25916c3a1
49615af82e5dc5fdc1edcc5478ca65605ee2a263f4eeeb9f5dedb6334fea9f4c
8ec236d6d8f3d593012a2c5cdf162874708f4808f253873c2cc84c823be3339c
```

## Decision

Accept the host-list split as a 0.3.1 performance improvement. It removes
repeated static work from the Portal's first host-list response without
weakening tenant scoping, selected-runtime surface discovery, or the private surface
gateway's independent authorization checks.

Do not use this evidence to raise the controlled user ceiling, adjust storage
budgets, approve formal production ingress, or claim real-user browser latency.
Those decisions remain outside 0.3.1.
