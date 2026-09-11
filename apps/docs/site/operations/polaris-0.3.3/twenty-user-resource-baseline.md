# Polaris 0.3.3 Twenty-User Resource Baseline

Date: 2026-08-09 UTC

Status: **measured linear baseline for 20 concurrent active vaults**. Full 20
hot Docker vaults were not run on the 15 GiB EPFL host because Docker default
address pools exhausted at 7 networks during an earlier run. Memory, storage,
and idle CPU growth were measured on 0→4 synthetic hot vaults, shown to be
linear, and extrapolated to 20. Who creates test resources destroys them.

## Measurement Method

- Host: EPFL test host, release `0.3.3`, Authing **disabled**.
- Image: digest-pinned private surface
  `127.0.0.1:5000/private-surface-admin-portal@sha256:e588c573…`.
- Synthetic user only; existing `cyruscyliu` data untouched.
- Samples at 0, 1, 2, 3, 4 simultaneously hot vaults after readiness.
- Cleanup via `trap` on the creating session (creator destroys).

Raw log: `site/public/release-evidence/0.3.3-20260809-20-baseline/`.

## Per-Vault Observed (Idle / Light)

| Signal | Measured | Notes |
| --- | ---: | --- |
| Container RSS | **255–274 MiB** (mean ≈ **263 MiB**) | Hard cap 512 MiB |
| Container CPU (idle) | **≈ 0.00–0.01%** | Hard cap 1000 millicores |
| Container writable layer | **≈ 225 KiB** | Shared image ≈ 7.93 GiB once |
| Polaris data dir / vault | **≈ 22 KiB** empty | Grows with user content up to quota |
| Docker root growth / vault | **≈ 127 KiB** | Metadata + thin RW; image not re-copied |
| Docker networks / vault | **+1** | Default bridge pool; host limit ~dozens |

Declared cgroup on each vault container:

```text
NanoCpus=1000000000   # 1.0 CPU
Memory=536870912      # 512 MiB
MemorySwap=536870912  # no extra swap
PidsLimit=128
```

## Linearity

Host **MemAvailable** over 0→4 synthetic hot vaults:

| Hot vaults | MemAvailable |
| ---: | ---: |
| 0 | 11.21 GiB |
| 1 | 10.94 GiB |
| 2 | 10.70 GiB |
| 3 | 10.44 GiB |
| 4 | 10.18 GiB |

Least-squares fit:

```text
MemAvailable ≈ 11.21 GiB − 0.256 GiB × N_hot
R² ≈ 0.999
```

An earlier 1→6 series on the same host gave **−262 MiB / vault**, R² 0.9994.
Both agree within a few percent.

Docker root used bytes and Polaris data bytes also grew **linearly** in N
(slopes ≈ +127 KiB and ≈ +30 KiB per empty vault). Idle CPU stayed flat near
zero; the **linear CPU budget** is the declared 1000 millicores cap, not idle
usage.

Therefore for N=20, with the same image and empty-to-light workload:

| Resource | Linear estimate at N=20 | Planning use |
| --- | --- | --- |
| Container RSS sum | 20 × 263 MiB ≈ **5.1 GiB** | Typical light load |
| Hard memory ceiling | 20 × 512 MiB = **10.0 GiB** | Must fit in host RAM |
| MemAvailable drop | 20 × 256 MiB ≈ **5.0 GiB** | From unloaded baseline |
| Shared private surface image | **≈ 8 GiB once** | Not × N |
| Writable layers | 20 × 225 KiB ≈ **4.4 MiB** | Empty |
| Logical hot storage cap | 20 × 512 MiB = **10.0 GiB** | Profile quota sum |
| Active workspace cap | 20 × 256 MiB = **5.0 GiB** | Profile quota sum |
| CPU hard caps sum | 20 × 1.0 = **20 CPUs** | Oversubscribe on 8-core host |
| Idle CPU sum | ≈ **0** | Not the sizing driver |
| Docker networks | **+20** | Must size address pools; creator must destroy each run |

## Twenty-User Configuration Baseline

This is the **0.3.3 single-host baseline** for claiming 20 concurrent active
vaults. It matches `config/release-profiles/0.3.0-single-host.json` capacity
`maxActiveVaults=20` and freezes the resource numbers operators must provision.

### Control plane

| Setting | Baseline |
| --- | --- |
| `POLARIS_RELEASE_ID` | `0.3.3` |
| `POLARIS_RELEASE_PROFILE` | `0.3.0-single-host` |
| Topology | single-host, 1 control plane, 1 gateway |
| `POLARIS_MAX_ACTIVE_VAULTS` | **20** |
| `POLARIS_JOB_WORKER_CONCURRENCY` | **1** |
| `POLARIS_JOB_LEASE_MS` | **60000** |

### Per-vault resource envelope (enforced)

| Setting | Baseline | Rationale |
| --- | ---: | --- |
| CPU | **1000 millicores** | Isolates noisy neighbor; expect oversubscribe |
| Memory / swap | **512 MiB / 512 MiB** | Measured RSS ~263 MiB light; headroom for spikes |
| PIDs | **128** | Unchanged from 0.3.0 envelope |
| Ephemeral storage | **512 MiB** | Matches hot-storage budget |

### Logical quotas (Polaris)

| Setting | Baseline |
| --- | ---: |
| Active workspace | **256 MiB** |
| Cache | **64 MiB** |
| Runtime state | **128 MiB** |
| Identity state | **64 MiB** (shared user budget; do not × vaults blindly) |
| Hot storage sum | **512 MiB** |

### Host minimum to run 20 hot vaults

| Host resource | Minimum baseline | Notes |
| --- | ---: | --- |
| RAM | **16 GiB** usable | 10 GiB vault hard caps + ~4 GiB platform + ≥2 GiB headroom |
| Recommended RAM | **32 GiB** | Comfortable for spikes, page cache, two colors |
| CPU | **8 cores** | Supports light multi-user; heavy coding will queue |
| Recommended CPU | **16 cores** | If many vaults CPU-bound together |
| Docker data root | **≥ 40 GiB free** after base images | 8 GiB image + 10 GiB hot + logs/layers |
| App data root | **≥ 20 GiB free** | 5 GiB workspace quotas + backups/keys margin |
| Docker networks | **≥ 24 usable user-defined networks** | 20 vaults + blue/green + extras |
| Load average target | **< cores** sustained | Idle samples were ~1 on 8 cores with 4 vaults |

EPFL (15 GiB, 8 cores, 40 GiB docker free) is **sufficient for the linear
model and partial hot runs**, not a proof rack for sustained 20 saturated
vaults. The blocking failure observed before full 20 was **Docker address
pool exhaustion at the 7th network**, not OOM.

### SLO (unchanged profile)

| SLO | Baseline |
| --- | ---: |
| Launch success | ≥ 99.5% |
| Read P95 | ≤ 500 ms |
| Mutation P95 | ≤ 1500 ms |
| Recovery | ≤ 120 s |
| 5xx | ≤ 1% |

Local concurrent multi-user gateway evidence at 20 synthetic identities:
read P95 75–95 ms, launch 100% (control-plane path, not 20 hot Docker
containers).

## Test Resource Ownership

**Whoever creates test resources destroys them in the same session.**

This includes **Docker networks**. Each hot vault compose project creates a
user-defined bridge network. Those networks consume the daemon address pool;
leaking them is what exhausted the pool at the 7th vault on EPFL. Networks are
not “platform leftovers” — if a run created them, that run deletes them.

Required for every EPFL or lab capacity run:

1. Use a unique synthetic user id prefix (`syn-…`).
2. `trap cleanup EXIT` (or equivalent) before the first create.
3. Cleanup order (all scoped to the synthetic prefix only):
   - stop vault containers
   - `docker rm` any remaining synthetic containers
   - delete Polaris vault records, then the synthetic user
   - `docker network rm` every synthetic project network
   - `docker volume rm` synthetic identity and runtime volumes
4. Never delete or modify real tenant paths, real vault networks (for example
   `cyruscyliu-*-default`), or blue/green platform networks.
5. Record before/after `du` on `/srv/polaris/data`, `docker network ls` count,
   and confirm the real user directory still exists.
6. If a run is interrupted, the same owner resumes cleanup before the next
   capacity experiment; do not start a new synthetic batch on a dirty network
   list.

## What This Baseline Does Not Claim

- Twenty CPU-saturated coding agents on an 8-core host.
- Production Authing multi-tenant matrix (formal origin).
- That EPFL’s default Docker bip/pool can host 20 simultaneous user-defined
  networks without pool reconfiguration.
- Storage under large upload corpora (use the 0.3.3 measurement corpus for
  that; empty-vault disk slopes are lower bounds).

## Pass Decision For 0.3.3 Capacity Raise

| Gate | Result |
| --- | --- |
| Profile `maxActiveVaults=20` | set |
| Linear memory model to 20 | pass (R²≈0.999, ~256–262 MiB/vault) |
| Linear storage model (empty/light) | pass (shared image + small RW) |
| CPU model | pass as **capped linear budget** 20×1 CPU; idle ≈0 |
| Host baseline published | this document |
| Creator-destroys test hygiene | required; exercised with trap cleanup |

**Conclusion:** 20 concurrent active vaults is an accepted **configuration
baseline** when the host meets the minimum table above and Docker networks
are provisioned. Partial hot-vault runs plus linear extrapolation are the
evidence on memory-constrained lab hardware; saturated 20-vault soak remains
a larger-host follow-up, not a reason to keep the profile at 10.
