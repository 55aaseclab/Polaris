# Remote Deploy

This document describes the current remote deployment model for Polaris.

It is written for the host-based deployment layout where:

- code is synced to a remote app directory
- data lives outside the repo
- nginx runs on the host
- blue/green switching is available for the remote Docker deployment

## Ownership Model

Separate these concerns clearly:

- repo code
- deployed app directory
- persistent data
- host nginx config
- host TLS material
- active color marker

Define these locations in the operator-managed deployment environment:

- app directory
- persistent data directory
- environment file
- active-color marker
- nginx upstream include

### Test-Host Layout

The designated HTTP test host uses these paths:

| Path | Owner | Deployment rule |
| --- | --- | --- |
| `/srv/polaris/app` | Polaris release artifact | Replaceable code and generated deployment files; safe for the repo sync |
| `/srv/polaris/data` | Polaris runtime | Persistent `control/` and `vault-data/` trees; never delete or replace during code sync |
| `/srv/polaris/docker-root` | Docker daemon | Docker images, layers, containers, and quota metadata; never sync, prune, or remove as part of an app deployment |
| `/etc/polaris/polaris.env` | Host operator | Secret-bearing runtime configuration; keep outside the repository |
| `/etc/polaris/active-color` | Deploy scripts | Current blue/green traffic marker |

`scripts/cd-remote.sh` syncs only the app artifact. It uses `rsync --delete`
with the persistent data and Docker root explicitly excluded, and
`--one-file-system` prevents a mounted runtime path from being traversed by the
sync. A failed or repeated deployment must not turn a code rollout into a data
or Docker-storage operation.

## Deployment Guardrails

- Run `scripts/cd-remote.sh` from the local Polaris checkout. The remote app
  directory is an artifact directory, not a source checkout.
- Do not run `git rev-parse`, rebuild, or otherwise inspect source from the
  remote app directory.
- Do not sync, prune, or delete `/srv/polaris/data` or `/srv/polaris/docker-root`
  as part of deployment.
- Existing hosts must be migrated offline with the manifest-driven
  `control-vault-data` tool before provisioning. The provisioner has no legacy
  export fallback.

## Local CI

Run local checks before syncing:

```bash
bash ./scripts/ci-local.sh
```

This local CI path intentionally avoids the full Polaris integration suite.
The default Polaris test entry is smoke-only.

Run the heavy suite only when you explicitly need it:

```bash
pnpm run test:polaris:full-minus-infra
```

## Remote Provision

First-time machine setup:

```bash
bash ./scripts/provision-remote.sh debian@your-server
```

Expected installed packages:

- `docker.io`
- `docker-compose-plugin`
- `nginx`
- `rsync`
- `curl`
- `git`
- Node.js 22
- `pnpm`

Provision also checks the host nginx gateway shape.

It expects the Polaris vhost to include the configured gateway upstream snippet
and forward traffic with `proxy_pass $polaris_upstream;`.

If that wiring is missing, provision exits with the exact nginx follow-up steps
instead of pretending the machine is ready.

## Environment

The host env file should define at least:

- `POLARIS_DATA_ROOT`
- `POLARIS_NETFS_LOCAL_EXPORT_ROOT`
- `POLARIS_PASEO_APP_BASE_URL`
- `VITE_POLARIS_API_BASE`

The host env file must also define the release gate variables used by
`scripts/release-preflight.sh`:

- `POLARIS_RELEASE_ID`
- `POLARIS_RELEASE_GATE_MODE`
- `POLARIS_WORKSPACE_BASE_IMAGE`
- `POLARIS_RELEASE_MANIFEST=deploy/release-manifest.json`
- `POLARIS_PORTAL_ALLOWED_ORIGINS`
- `POLARIS_JOB_LEASE_MS`

The public origin is owned by Polaris. Private runtime targets are reached only
through the existing same-origin gateway and have no public subdomain. Digest-
pinned image references are part of the release manifest and preflight checks;
do not treat them as a separate registry-push workflow.

`scripts/deploy-polaris.sh` runs `scripts/release-preflight.sh` before it
builds the inactive color or changes traffic. Preflight checks pinned image
references, a matching manifest, gateway routing, Docker storage quotas, and the
absence of public implementation ports.

### Candidate Manifest

Generate the manifest after the digest-pinned image references are written
into the environment file. Capture the Polaris commit in the local checkout
before syncing. The remote app directory is an artifact directory and
intentionally has no `.git`, so do not run `git rev-parse` there. The command
does not execute the env file or copy its secrets into the manifest:

```bash
POLARIS_SOURCE_COMMIT="$(git rev-parse HEAD)"  # run in the local Polaris checkout

node scripts/create-release-manifest.mjs \
  --env-file /etc/polaris/polaris.env \
  --output deploy/release-manifest.json \
  --source-commit "${POLARIS_SOURCE_COMMIT}" \
  --previous-manifest-sha256 <previous-manifest-sha256> \
  --evidence gateway-p0,backup-p0,capacity-p0
```

When the generator runs on the remote host, export the captured value in the
same shell or pass it through the deployment wrapper. Never substitute the
remote artifact directory's nonexistent Git checkout for this value.

For the first `0.3.0` manifest only, use `--migration initial` and set
`--previous-manifest-sha256` to 64 zeroes. That is the explicit genesis marker;
every later candidate must name the SHA-256 of the previous verified manifest.

The manifest contains only image digests, a hash of the environment file,
source commit, migration label, evidence references, and the previous manifest
digest. `cd-remote.sh` preserves an existing remote manifest and synchronizes a
local `deploy/release-manifest.json` when one is present. Deployment still
fails closed if the remote file is absent or does not match the env file.

Keep secrets out of the repo.

The deployed web env must match the configured public origin and browser
session auth settings for this release profile. Do not add ad hoc portal auth
variables here.

`POLARIS_DATA_ROOT` is mandatory.
Do not rely on repo-local fallback paths for deployed or long-running
processes.

Local live-auth tests source `.env.dev` and use the configured
`POLARIS_DATA_ROOT`.

Vault lifecycle and durable-job work run in `polaris-server`. There is no
separate executor service, bridge, callback listener, or executor base URL to
configure.

## Persistent Data

Production user and workspace state belongs under the external data root.

Required directories below the configured data root:

- `control/users/`
- `control/state/`
- `control/backup-keys/`
- `vault-data/tenants/`

Do not couple production state to the checked-out repo path.
The Docker daemon's data root is a separate persistence boundary and is not a
Polaris application data directory.

## Deploy Artifact

The remote Docker deployment entrypoint is:

- `deploy/docker-compose.polaris-bluegreen.yml`

Blue/green deploy should:

1. deploy the inactive color
2. verify it is healthy
3. switch the nginx upstream target
4. keep rollback cheap

## Remote Deploy

```bash
bash ./scripts/cd-remote.sh debian@your-server
```

Expected flow:

1. run local CI
2. build the required Paseo artifacts locally, then sync source from the local
   checkout to the remote app dir
3. run release preflight and start the inactive `polaris-server` color
4. rebuild the inactive `paseo-app` stack and verify its health
5. update the host nginx upstream target
6. reload nginx

Each deploy restarts only the inactive `polaris-server@<color>` service before
traffic switches. No executor or bridge service exists.

## Remote Rollback

```bash
bash ./scripts/rollback-remote.sh debian@your-server
```

Rollback should only switch traffic back to the previous healthy color.

## Host Nginx

The public entry nginx should live outside this repo if the host serves more
than Polaris.

The important rule is that nginx terminates public traffic and forwards the
Polaris domain to the active local upstream.

## Operational Checks

After deploy, verify:

```bash
docker ps
docker compose -f deploy/docker-compose.polaris-bluegreen.yml ps
curl -I https://your-domain.example
curl -sS https://your-domain.example/api/users
```

Also verify the optimized status path:

```bash
curl -sS https://your-domain.example/api/users/<user>/workspaces/<workspace>
curl -sS -X POST https://your-domain.example/api/users/<user>/workspaces/<workspace>/refresh
docker logs <workspace-container> | tail -n 100
```

You want to confirm:

- the portal can serve cached workspace detail immediately
- explicit refresh still works
- the active `polaris-server` reports current runtime status
- deploy output reports the active color after the upstream switch

## Debugging

When deploy behavior diverges, inspect:

1. remote deploy script output
2. docker compose logs for active and inactive colors
3. host nginx error log
4. Polaris API health

Then separate the issue into one of these buckets:

### image reuse not working

Symptoms:

- workspace create falls back to minute-scale Docker build
- repeated equivalent workspaces rebuild the same prebuilt layer

Check:

- `workspace-shared-image-build`
- `workspace-image-reused`
- `workspace-image-tag`

### embedded Paseo assets or auth broken

Symptoms:

- embedded Paseo page stays blank
- browser requests the wrong asset host
- `/api/session` returns `401` inside the embedded app

Check:

- deployed web env contains the intended origin and auth settings
- the deployed Paseo web bundle is built with the correct `/paseo` base path
- the embedded app can reach `GET /api/session` on the Polaris origin

### cached status not being updated

Symptoms:

- portal opens quickly but shows stale runtime state
- explicit refresh fixes the page

Check:

- `workspace-status-cached`
- `workspace-status-reported`
- `workspace-status-refresh-started`
- `workspace-status-refresh-completed`
