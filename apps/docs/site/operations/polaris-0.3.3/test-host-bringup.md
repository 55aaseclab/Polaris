# Polaris 0.3.3 Test-Host Bring-Up

Status: working notes for the designated HTTP test host candidate. This is not
production approval.

## Target

```text
host: root@m00e04c1b76c0.dyn.epfl.ch
public origin: http://m00e04c1b76c0.dyn.epfl.ch
gate mode: local-test
release id: 0.3.3
profile id: 0.3.0-single-host
max active vaults: 20
```

Use only this host for 0.3.3 deployment and service tests. Do not start Polaris
services on the operator workstation.

## Bring-Up Sequence

1. Land the Polaris candidate that raises `maxActiveVaults` to 20 and bumps
   `POLARIS_RELEASE_ID` to `0.3.3`.
2. On the host env file, set at least:
   - `POLARIS_RELEASE_ID=0.3.3`
   - `POLARIS_MAX_ACTIVE_VAULTS=20`
   - `POLARIS_RELEASE_GATE_MODE=local-test`
   - optional first smoke: `POLARIS_AUTH_MODE=disabled`
3. Rebuild the release manifest from the local Polaris checkout commit and the
   host env hash. Never invent the remote app directory as a Git source.
4. Run `bash ./scripts/cd-remote.sh root@m00e04c1b76c0.dyn.epfl.ch`.
5. Smoke:
   - `/healthz` and `/readyz` return `200`
   - public raw `9090` remains closed
   - with auth disabled, `/api/session` returns the local development session
   - with Authing restored, unauthenticated `/api/session` returns `401`
6. Restore `POLARIS_AUTH_MODE=authing-browser-session` before any production
   gate or formal-origin work.

## Host Resource Snapshot

Captured at candidate start on the designated host:

| Resource | Observed | 20-vault implication |
| --- | --- | --- |
| RAM | 15 Gi total, ~11 Gi available | 20 × 512 Mi ≈ 10 Gi vault budget; little headroom if all vaults are hot |
| CPU | 8 cores | one worker concurrency remains 1; do not claim multi-worker scaling |
| Docker root | 64 Gi loop, ~40 Gi free | enough for candidate layers; still prune carefully |
| App data | small synthetic state | safe for disposable capacity fixtures |

If the 20-user stage exhausts memory or the Docker writable layer, stop and
record the measured lower ceiling. Do not raise per-vault memory to hide
pressure.

## Auth Disable Rules

- Allowed only when `POLARIS_RELEASE_GATE_MODE=local-test`.
- Production preflight still rejects any mode other than
  `authing-browser-session`.
- Disabled auth returns one fixed local development session. It is useful for
  operator smoke and single-session launch checks.
- Multi-identity capacity fixtures still need distinct Authing (or synthetic
  cookie/header) identities. Disabled auth does **not** prove 20 distinct
  tenants.

## Test Resource Ownership

Whoever creates synthetic users, vaults, containers, **Docker networks**, or
volumes on the EPFL host destroys them in the same session. Vault compose
networks count: they use the daemon address pool and must be removed with the
batch that created them. Use a `syn-` prefix, install a cleanup `trap` before
the first create, clean networks/volumes after vaults, and never delete real
tenant data or platform blue/green networks.

## Open Questions Requiring Code Or Measurement

Record each item here until closed with a code change or measured evidence.
Do not invent answers.

### OQ-1: Profile id versus release id

The capacity file remains `config/release-profiles/0.3.0-single-host.json`
while `POLARIS_RELEASE_ID` becomes `0.3.3`. `release-profile.mjs` only accepts
the `0.3.0-single-host` id. Keep this split unless a later change introduces a
versioned profile schema and migrates all env, preflight, and launcher checks.

### OQ-2: One host, two public origins

The designated test host still serves
`http://m00e04c1b76c0.dyn.epfl.ch` under local-test. Formal origin evidence for
`https://polaris.jianxiaoyitech.com` lives on a different public address path
and is a 0.3.2 perimeter concern. Confirm which host owns which origin before
writing dual-origin env values into one candidate.

### OQ-3: Disabled-auth multi-user load

`scripts/release/capacity-gateway-load.mjs` requires fixture stages with
distinct Authing user ids and a portal cookie/header pair. With
`POLARIS_AUTH_MODE=disabled`, the portal collapses to one local user. Decide
whether stage-B proof must always re-enable Authing, or whether a synthetic
multi-session fixture is needed for disabled-auth load runs.

### OQ-4: Concurrent vault memory headroom

The profile still budgets 512 Mi memory and 1 CPU per vault. Twenty concurrent
hot vaults need roughly 10 Gi plus control-plane and Docker overhead on a 15 Gi
host. Measure peak RSS under stage B before claiming the ceiling is safe for
production hardware with less free RAM.

### OQ-5: Remote env still lagged release identity

At candidate start the test host env still showed an older
`POLARIS_RELEASE_ID` and `maxActiveVaults=10` while code had moved ahead.
Every deploy must rewrite both the env values and the release manifest hash
together; do not treat a running healthz as proof of the new ceiling.

### OQ-6: Category quota enforcement depth

The plan still lists cache, runtime, identity, job staging, and backup
category accounting as workstreams. Raising `maxActiveVaults` alone does not
close those enforcement gaps. Stage B may ship with the existing active
workspace quota if the open workstreams are explicitly deferred and named.

## Evidence Naming

Store 0.3.3 test-host results under a dedicated evidence path, for example:

```text
site/public/release-evidence/0.3.3-<date>-test-host/
site/operations/polaris-0.3.3/<evidence-page>.md
```

Do not append 0.3.3 capacity rows to the 0.3.0, 0.3.1, or 0.3.2 registers.
