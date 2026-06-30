# Remote Deploy

This document describes the intended remote deployment model for Polaris.

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

Typical remote layout:

- app dir: `/srv/polaris/app`
- data dir: `/srv/polaris/data`
- env file: `/etc/polaris/polaris.env`
- active color file: `/etc/polaris/active-color`
- nginx upstream file: `/etc/nginx/snippets/polaris-gateway-upstream.conf`

## Local CI

Run local checks before syncing:

```bash
bash ./scripts/ci-local.sh
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

It expects the Polaris vhost to:

- include `/etc/nginx/snippets/polaris-gateway-upstream.conf`
- forward traffic with `proxy_pass $polaris_upstream;`

If that wiring is missing, provision exits with the exact nginx follow-up steps
instead of pretending the machine is ready.

## Environment

The host env file should define at least:

- `POLARIS_DATA_ROOT`
- `POLARIS_NETFS_LOCAL_EXPORT_ROOT`
- `POLARIS_PASEO_APP_BASE_URL`
- `POLARIS_EXECUTOR_BASE_URL`
- `POLARIS_RUNTIME_EXECUTOR_BASE_URL`
- `VITE_POLARIS_API_BASE`

Keep secrets out of the repo.

`POLARIS_DATA_ROOT` is mandatory.
Do not rely on repo-local fallback paths for deployed or long-running
processes.

Local live-auth tests should set `POLARIS_DATA_ROOT=./config` through
`.env.test`.

For the current status model, executor reachability is no longer optional.

Why:

- runtime status observer reports status patches back to the executor
- container-to-host resolution is part of normal status freshness
- if this path is broken, the UI may look stale even when the runtime is fine

Polaris should also fail clearly when `POLARIS_EXECUTOR_BASE_URL` points to the
wrong service.
Executor failures are reported as executor failures.
They are not silently re-routed into in-process fallback behavior.

## Persistent Data

Production user and workspace state belongs under the external data root.

Examples:

- `/srv/polaris/data/users`
- `/srv/polaris/data/state`
- `/srv/polaris/data/exports/workspaces`

Do not couple production state to the checked-out repo path.

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
2. rsync repo to remote app dir
3. build and start inactive color
4. verify health
5. update host nginx upstream target
6. reload nginx

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
- runtime status observer can reach the executor when the workspace is running

## Debugging

When deploy behavior diverges, inspect:

1. remote deploy script output
2. docker compose logs for active and inactive colors
3. host nginx error log
4. Polaris API health
5. executor reachability from runtime containers

Then separate the issue into one of these buckets:

### image reuse not working

Symptoms:

- workspace create falls back to minute-scale Docker build
- repeated equivalent workspaces rebuild the same prebuilt layer

Check:

- `workspace-shared-image-build`
- `workspace-image-reused`
- `workspace-image-tag`

### cached status not being updated

Symptoms:

- portal opens quickly but shows stale runtime state
- explicit refresh fixes the page

Check:

- `workspace-status-cached`
- `workspace-status-reported`
- `workspace-status-refresh-started`
- `workspace-status-refresh-completed`

### executor unreachable from runtime

Symptoms:

- daemon is fine
- workspace is running
- UI stays behind or pairing state lags

Check:

- runtime status observer log
- executor base URL env
- host resolution from inside the container

If runtime status reporting fails, confirm the container can resolve the host:

```bash
docker exec <container> getent hosts host.docker.internal
```

If that fails, fix the render or compose host-gateway mapping before debugging
higher-level status behavior.

Also confirm the executor URL itself is correct from inside the container:

```bash
docker exec <container> sh -lc 'echo "$POLARIS_RUNTIME_STATUS_REPORT_URL"'
docker exec <container> sh -lc 'curl -sS "$POLARIS_RUNTIME_STATUS_REPORT_URL" -o /dev/null || true'
```

If this path is broken, the deployment is missing part of the current Polaris
performance model, even if the main app still responds.
