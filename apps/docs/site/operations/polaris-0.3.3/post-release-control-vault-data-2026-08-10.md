# Polaris 0.3.3 Post-Release: Control And Vault-Data

Date: 2026-08-10 UTC

Status: **post-release maintenance entry**. This records the 0.3.3 data-layout
cutover and the focused verification associated with it.

## Contract Change

The host layout is now:

```text
$POLARIS_DATA_ROOT/control/users
$POLARIS_DATA_ROOT/control/state
$POLARIS_DATA_ROOT/control/backup-keys
$POLARIS_DATA_ROOT/vault-data/tenants/{tenant}/vaults/{vault}
```

Integrated runtimes use direct `/vault/workspaces`, `/vault/backups`, and
`/vault/cache` mounts. Polaris remains the owner of the control plane,
provisioning, backup, restore, activation, rollback, and audit lifecycle.

The implementation does not retain a runtime compatibility read for the old
top-level control roots, the old export tree, or `/vault/project`. Existing
hosts use the explicit `control-vault-data` migration script before restart.

## Reviewed Changes

| Repository | Reviewed baseline | Focus |
| --- | --- | --- |
| Polaris | `ee19637` | paths, mounts, jobs, migration CLI |
| private surface | `63c716c` | fixed direct runtime roots and standalone boundary |
| Docs | `e6e6bfe` | architecture and release documentation site |

The reviewed implementation adds the migration module, CLI entry, release
preflight checks, direct-root test assertions, and the documentation updates
recorded in this batch.

## Portal And Paseo Ownership Follow-Up

Date: 2026-08-11 UTC

Polaris commit `d9e52bd` extracts the browser Portal into the independent
`apps/polaris-portal` React application and moves the Polaris-owned Paseo
integration boundary from `apps/paseo` to `packages/paseo`. The move covers the
upstream checkout location, patch stack, artifact and tool-bundle Dockerfiles,
local build cache paths, workspace-base image input, rsync filters, and
regression fixtures. `apps/paseo-embed-demo` remains a separate demo app, and
the nested Paseo source remains its own upstream npm workspace.

The Portal build now versions `shell.js` and `shell.css` references from their
content hashes. This keeps the public static adapter cache-aware without
changing the same-origin API, Gateway, session, or vault ownership boundary.

The implementation checks below were run locally. The remote deployment and
read-only smoke evidence are recorded separately below; no tenant data
migration or business-data mutation was performed.

| Check | Result |
| --- | --- |
| Portal typecheck, build, and frontend tests | passed; `4/4` frontend tests |
| `pnpm run test:surfaces` | passed; `40/40` tests |
| `pnpm --filter polaris run check` | passed |
| Paseo local/deployment contract tests | passed; `24/24` tests |
| Portal backend test file | passed; `53/53` tests |
| Portal live-stream test file | passed; `6/6` tests |
| Paseo artifact Dockerfile `buildx --call=check` | passed |

## Remote Deployment Follow-Up

Date: 2026-08-11 UTC

The candidate was deployed to the designated HTTP test host through
`scripts/cd-remote.sh`. The release preflight passed before the inactive color
was built and traffic was switched.

| Check | Result |
| --- | --- |
| Candidate source | `d9e52bd` |
| Release manifest | `0.3.3`, migration `post-release-portal-paseo-20260811` |
| Manifest SHA-256 | recorded below |
| Previous manifest SHA-256 | recorded below |
| Active color and upstream | blue; loopback `18080` |
| Health, readiness, Portal, and Paseo routes | passed; all expected `200` |
| Portal asset versioning | passed; hashed JS/CSS URLs served |
| Synthetic Paseo `/h` route and metadata | passed; `200` |
| Unauthenticated `/g/` boundary | passed; `401` |
| Public `9090` listener | none |
| External read-only smoke | passed; `10/10` |

Manifest SHA-256:
`68c28656d5af2753526f70e4fa3630d8f69e589d21049c71a3949d6f8e14e39b`

Previous manifest SHA-256:
`e464cdaba4b9c4c9eb77aa7ee1368d5cd4fe7299043f6c85251c1bad1ae69703`

The read-only Portal projections returned 200; the host projection contained no
direct `port` or `ports` fields. The obsolete remote `apps/paseo` build tree
was removed only after confirming that no running process referenced it. The
remote data root remained present, and the active blue Polaris and Paseo
containers remained healthy after cleanup.

## Focused Checks

The local focused checks passed before and after the remote cutover:

| Check | Result |
| --- | --- |
| Polaris check/build | passed |
| Polaris non-infra regression tests | `257/257` |
| Polaris control/vault-data migration tests | `6/6` |
| Polaris backup/restore/runtime focused tests | `32/32` |
| `@polaris/vault-runtime` tests | `10/10` |
| private surface workflow tests | `37/37` |
| private surface core tests | `34/34` |
| Release and remote-provision contract tests | `38/38` |
| Docs VitePress build and Mermaid check | passed |

The private surface doctor and fixed-root tests passed locally. The remote host has no
private surface surface, so a remote private surface doctor or private surface gateway workspace check
was **not applicable** and is not claimed as remote evidence.

## Remote Cutover Record

Host: `root@m00e04c1b76c0.dyn.epfl.ch`.

The host was stopped before the offline migration, restarted with the green
Polaris service, and then checked against the applied report. The reviewed
manifest is:
`/srv/polaris/migrations/control-vault-data.manifest.remote-20260810.json`.

### Migration Evidence

- Manifest: 25 entries, 22 vault roots, one rewritten spec, and one explicitly
  ignored empty regular file (`control.sqlite`, SHA-256
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`).
- Manifest SHA-256:
  `4102de7fa8794aa754e67dd91d8647fa96329cc17e40822df3635482382203de`.
- Dry-run report:
  `/srv/polaris/migrations/control-vault-data.dry-run-20260810.json`, SHA-256
  `9ab99f422ae80b5cf782ef0d7f1ec927625e5fe5cc9c711deaff4c1a6b7843db`.
- Apply report:
  `/srv/polaris/migrations/control-vault-data.apply-20260810-r2.json`, state
  `applied`, SHA-256
  `28af68721537582a82eb57a69195ec8f089ad1dccb19b2b624d58b776ff5e92f`.
- The apply report records all 25 source and target fingerprints. The control
  fingerprints were: `users` source
  `9d4bb095d4c68c1480ec3a9ef81777d44a787fd9dc3dd8427e710997c910ba0a`, target
  `5c86297049bc30598d6805e663de2975b0d3b5f595b3704502b1560fa8dde7fc` after
  the structured spec rewrite; `state` matched at
  `8ac5b871173158d3c03d2ead54ee2ee64d8a3d9f815c248039aa1c89856a33cd`; and
  empty `backup-keys` matched at
  `ff76585b5dd8f018bbd5c581e4e81963093def7098b7fcf9caa2f524029492dd`.
- Four non-empty vault workspace leaves matched source to target:
  `coding-vertical` at
  `b59748e270fed5592871c30fc9cbc94eb620ca8cff3b695815c4094e698ebf32`,
  `repro-coding-a-20260809` at
  `9e683e7da5d8e06cad1c456626f4c443909d0e998327e20295b13f0f5e6f8257`,
  `repro-coding-b-20260809` at
  `89cc459ea3f2a8bf4689283e2299dcffb116eb28cb715df05ee98fb807263a5f`, and
  `test-coding` at
  `75a35539e0c0221c14a222d03dffcd0a48a0b1c1114740eb83e2d4149fbee275`.
  The remaining 18 empty leaves matched at
  `c35ee5d2c6d767389de69a7e9806a6fdb439cf5b4bad67f9c6b843f0eeb9714d`.

### Service Verification

- The active release manifest at `/srv/polaris/app/deploy/release-manifest.json`
  has SHA-256
  `e464cdaba4b9c4c9eb77aa7ee1368d5cd4fe7299043f6c85251c1bad1ae69703`.
- `/etc/fstab` contains only the canonical bind:
  `/srv/polaris/data/vault-data` to `/exports/polaris/vault-data`.
  `/etc/exports` publishes only
  `/exports/polaris/vault-data 127.0.0.1/32(...)`.
- `control/state/control.sqlite`, its WAL, and its SHM are open by the active
  green Polaris process. Read-only SQLite verification returned
  `integrity_check` `ok` and journal mode `wal`.
- The exact pre-archive `/proc` scan found zero open FD, cwd, or root paths
  under old `users`, `state`, `backup-keys`, `exports/vaults`, or `vaults`.
  After archiving, those old paths are absent and the archive is not opened by
  any process.
- External `/healthz`, `/readyz`, `/api/session`, and the scoped vault status
  endpoint returned `200`. The selected driver is Docker and its lifecycle is
  `running`.
- The `test-coding` container has exactly the direct `/vault/workspaces`,
  `/vault/backups`, and `/vault/cache` bind mounts, with no `/vault/project`.
  A scoped read of `/vault/workspaces/.polaris/MEMORY.md` succeeded.
- Port `9090` was unreachable from the external host check.

### Archive

The old source is archived at
`/srv/polaris/archive/control-vault-data-20260810`. It contains the old
`users`, `state`, `backup-keys`, and `exports/vaults` trees plus the ignored
empty `control.sqlite` residue. The empty old mountpoints were removed only
after the service and FD checks passed.

The remote vault list reports `surfaces: ["paseo"]` and `private-surfaceId: null`, and
the running container has no `/opt/private-surface`. Consequently, remote private surface
doctor, private surface gateway, and private surface-specific workspace checks are recorded as
not applicable for this host; local private surface fixed-root coverage remains the
applicable evidence.

The old source remains recoverable in the archive. Rollback uses the migration
report and is refused if a target fingerprint changes.
