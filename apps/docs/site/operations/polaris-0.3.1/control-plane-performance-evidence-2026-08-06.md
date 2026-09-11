# Polaris Control-Plane Performance Evidence: 2026-08-06

Status: profiling gate complete. This is local synthetic control-plane
evidence for the post-release Polaris 0.3.1 performance maintenance batch. It
is not test-host, browser, Authing, storage, capacity, or higher-user-count
evidence.

## Scope

This record covers the three paths that were previously left unprofiled:

- normal durable `vault-provision` worker dispatch;
- the control-store mutation-admission sequence;
- a bounded `POST /g/api/workspaces` mutation through the Polaris gateway.

The accepted code change is commit `64b0b51`. It avoids the second backend
status synthesis when a provision job does not request `startAfterCreate`.
Started jobs retain the final post-start status synthesis. The baseline runs
were captured before that conditional was present, with the same profiling
harness and fixture.

## Fixture

- Three serial baseline worker/control-store runs and three serial candidate
  runs.
- `150` measured samples and `20` warmup samples per run.
- Node `v22.23.1`, Linux `6.12.74+deb13+1-amd64`.
- The runner starts a disposable child process with a temporary
  `POLARIS_DATA_ROOT` and two temporary SQLite stores.
- The worker fixture provisions one synthetic vertical vault repeatedly through
  the real durable worker. Docker is replaced only inside the child process by
  a minimal fake binary; no Docker daemon, image registry, or remote host is
  contacted.
- The bounded mutation fixture starts a loopback Portal and fake private surface
  upstream. Workspace usage, idempotency, workspace locking, quota
  reservation/reconciliation, audit, assertion, and response replay all run
  through the real Polaris gateway code.

Commands:

```sh
pnpm --filter polaris run benchmark:control-plane -- \
  --samples 150 --warmup-samples 20 --profile-dir <capture-dir>

pnpm --filter polaris run benchmark:gateway -- \
  --vaults 10 --samples 150 --warmup-samples 20 --profile-dir <capture-dir>
```

Each profile is scoped to its measured loop using the V8 Inspector CPU
profiler. The JSON result beside each profile records its sample count,
duration, SHA-256, P50/P95/P99, errors, CPU, RSS, and event-loop signals.

## Results

Values are the median of the three per-run percentile summaries. Times are in
milliseconds.

| Operation | Baseline P50 | Candidate P50 | Baseline P95 | Candidate P95 | P95 change |
| --- | ---: | ---: | ---: | ---: | ---: |
| Control-store mutation admission | 0.48 | 0.46 | 0.63 | 0.58 | -7.9% (not targeted) |
| Durable worker provision | 32.10 | 18.63 | 37.50 | 24.48 | -34.7% |

The worker P99 moved from `38.55 ms` to `25.25 ms`. All six worker runs
recorded zero errors. The process-level median signals across the same worker
and control-store fixture were:

| Signal | Baseline | Candidate | Change |
| --- | ---: | ---: | ---: |
| User CPU | 2404.07 ms | 1670.53 ms | -30.5% |
| System CPU | 1430.02 ms | 824.38 ms | -42.4% |
| Peak RSS | 142991360 bytes | 141283328 bytes | -1.2% |
| Event-loop delay P95 | 37.58 ms | 24.64 ms | -34.4% |

The bounded-mutation profile-only runs recorded zero errors. Their median
latency was P50 `7.53 ms`, P95 `8.80 ms`, and P99 `9.45 ms`. No bounded
mutation implementation change is claimed by this record.

## Profile Findings

- The worker baseline spent most sampled CPU time in repeated child-process
  launches, Docker inspection, YAML parsing, and status-file synthesis. The
  duplicate final status call was removed only for the no-start case.
- The candidate worker profile shows the same remaining work once per
  provision, with no authorization, lifecycle, or durable-job guarantee
  removed.
- The control-store profile is dominated by native SQLite `prepare`, `get`,
  and `run` calls. No statement-cache refactor was accepted from this small
  fixture because the measured path is already sub-millisecond and the
  change would enlarge the control-store risk surface.
- The bounded-mutation profile is dominated by loopback HTTP/Undici waiting
  and response handling. Further network or filesystem changes require a
  separate fixture and are not claimed here.

## Raw Artifacts

Worker and control-store baseline runs:

| Run | Result JSON | Control-store profile | Worker profile |
| ---: | --- | --- | --- |
| 1 | [JSON](/release-evidence/0.3.1-20260806-control-plane-performance/baseline-pre-worker-status-run-1.json) | [profile](/release-evidence/0.3.1-20260806-control-plane-performance/profiles/baseline-pre-worker-status-run-1-control-store.profile.json) | [profile](/release-evidence/0.3.1-20260806-control-plane-performance/profiles/baseline-pre-worker-status-run-1-worker.profile.json) |
| 2 | [JSON](/release-evidence/0.3.1-20260806-control-plane-performance/baseline-pre-worker-status-run-2.json) | [profile](/release-evidence/0.3.1-20260806-control-plane-performance/profiles/baseline-pre-worker-status-run-2-control-store.profile.json) | [profile](/release-evidence/0.3.1-20260806-control-plane-performance/profiles/baseline-pre-worker-status-run-2-worker.profile.json) |
| 3 | [JSON](/release-evidence/0.3.1-20260806-control-plane-performance/baseline-pre-worker-status-run-3.json) | [profile](/release-evidence/0.3.1-20260806-control-plane-performance/profiles/baseline-pre-worker-status-run-3-control-store.profile.json) | [profile](/release-evidence/0.3.1-20260806-control-plane-performance/profiles/baseline-pre-worker-status-run-3-worker.profile.json) |

Worker and control-store candidate runs (`64b0b51`):

| Run | Result JSON | Control-store profile | Worker profile |
| ---: | --- | --- | --- |
| 1 | [JSON](/release-evidence/0.3.1-20260806-control-plane-performance/candidate-64b0b51-run-1.json) | [profile](/release-evidence/0.3.1-20260806-control-plane-performance/profiles/candidate-64b0b51-run-1-control-store.profile.json) | [profile](/release-evidence/0.3.1-20260806-control-plane-performance/profiles/candidate-64b0b51-run-1-worker.profile.json) |
| 2 | [JSON](/release-evidence/0.3.1-20260806-control-plane-performance/candidate-64b0b51-run-2.json) | [profile](/release-evidence/0.3.1-20260806-control-plane-performance/profiles/candidate-64b0b51-run-2-control-store.profile.json) | [profile](/release-evidence/0.3.1-20260806-control-plane-performance/profiles/candidate-64b0b51-run-2-worker.profile.json) |
| 3 | [JSON](/release-evidence/0.3.1-20260806-control-plane-performance/candidate-64b0b51-run-3.json) | [profile](/release-evidence/0.3.1-20260806-control-plane-performance/profiles/candidate-64b0b51-run-3-control-store.profile.json) | [profile](/release-evidence/0.3.1-20260806-control-plane-performance/profiles/candidate-64b0b51-run-3-worker.profile.json) |

Bounded-mutation profile runs (`64b0b51`):

| Run | Result JSON | Profile |
| ---: | --- | --- |
| 1 | [JSON](/release-evidence/0.3.1-20260806-control-plane-performance/candidate-64b0b51-mutation-run-1.json) | [profile](/release-evidence/0.3.1-20260806-control-plane-performance/profiles/candidate-64b0b51-run-1-bounded-mutation.profile.json) |
| 2 | [JSON](/release-evidence/0.3.1-20260806-control-plane-performance/candidate-64b0b51-mutation-run-2.json) | [profile](/release-evidence/0.3.1-20260806-control-plane-performance/profiles/candidate-64b0b51-run-2-bounded-mutation.profile.json) |
| 3 | [JSON](/release-evidence/0.3.1-20260806-control-plane-performance/candidate-64b0b51-mutation-run-3.json) | [profile](/release-evidence/0.3.1-20260806-control-plane-performance/profiles/candidate-64b0b51-run-3-bounded-mutation.profile.json) |

## Profile Checksums

The profile SHA-256 values are also present in each result JSON:

```text
baseline control-store:
3a4751f5f757f2bf88de6fb1190ff43ddf306b99976fb468cca030af265698a6
aaf04328f897766352f12de6e49ee50b95e57891db7ed9a4500b0b11f847b94d
3d8f96bc9ba011f5dc8dcba56ba8f241be457c9c64b31adfd607874cbf94552e

baseline worker:
91e2244dc1fea7739f43fc040a5fc20de318e1d00a874c189a3563b1756a537e
244c798b8a081d6eb9d75b0082c7f44cecd6bfcc2a514cc37ab2d6c2edd13f86
8df2b0acf4149a0d5b12b808b950067762a54e2a7adf4ebbd7edd5ea7deccbb6

candidate control-store:
118c1975a124063b2bf5b5f74bd81de9b8e4f6dfd5ae49510536be7837ea0aca
4d8f829c7371b466ebec80fa9d885cdee37124e8b2fcb05fe29aea132e6b1cec
dac82bd5ce04190c44ba2a654a54f14d75b79dfcd7799638fc7d814c40a02d8f

candidate worker:
e7e1f88d53c300eeb3f3b0a1947fad12d13a6a454b3039136efee3c0d67a64aa
4b99eb53c7dfe43b0a3e94487a2c07812a829015726cacbf807af7a67cd84e2c
fdf75c22bfde85010c0a0c43a470bd2dda7277439a6809b4b24f23a7835ab4c4

candidate bounded mutation:
c7417c07fc25175342e5456ed67431af6f8c5957ae381d448a75e8d3f633ba5d
7a9b641b85fe581e40fe572184b69ac0a4be05c504abc7c40a859e1930faf215
a7e4afec144284c6d34bd32e0b27aa951c6e4d0b522589bf88f34624ae28cf41
```

## Decision

Mark the remaining worker, control-store, and bounded-mutation profiling gate
complete. Accept only the measured worker duplicate-status reduction as a
performance change. Keep deeper SQLite statement caching and bounded-mutation
network/filesystem work as separate maintenance candidates.

This evidence does not raise the supported user count, change storage
allocation, alter quota policy, or promote commit `64b0b51` to the designated
test host.
