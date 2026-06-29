# Polaris

Polaris is the control plane for isolated development environments and external
AI coding agents.

It manages:

- user profiles
- workspace specs
- credential bindings
- runtime rendering
- workspace lifecycle
- cached status
- daemon pairing
- evolution state

Polaris currently supports `docker`, `pod`, and `kubevirt-vm` backends.

## Main Entry Points

The repo exposes three main Polaris surfaces:

- CLI and services:

```bash
pnpm --dir apps/polaris run polaris --
```

- Local web portal:

```bash
pnpm --filter polaris-web exec vite --host 0.0.0.0
```

- Local stack wrapper:

```bash
bash ./scripts/run-polaris-local-stack-service.sh .env.dev
```

## Stack Topology

Polaris has four main runtime pieces:

1. `polaris-server`
2. `polaris-executor`
3. `polaris-web`
4. `paseo-app`

### Responsibilities

- `polaris-server`
  serves the portal API and reads persisted workspace state
- `polaris-executor`
  performs lifecycle work that may be slow or side-effecting
- `polaris-web`
  provides the browser UI
- `paseo-app`
  renders the pairing portal for a workspace daemon

## Service Ports

Default local ports:

- `6767`: Paseo daemon inside a workspace
- `8082`: Paseo web app
- `8787`: Polaris portal API
- `8788`: Polaris executor API
- `8081`: Polaris web portal in local dev mode

## Data Ownership

Polaris code and Polaris data are separate concerns.

Code lives in this repo.
User and workspace data live under `POLARIS_DATA_ROOT`.

Important roots:

- `POLARIS_DATA_ROOT/users`
- `POLARIS_DATA_ROOT/state`
- `POLARIS_NETFS_LOCAL_EXPORT_ROOT`

The current local dev example uses:

- `POLARIS_DATA_ROOT=/home/debian/jianxiaoyi/data/polaris/data`
- `POLARIS_NETFS_LOCAL_EXPORT_ROOT=/home/debian/jianxiaoyi/data/polaris/data/exports/workspaces`

Do not treat repo-local generated files as production data storage.

## Workspace Lifecycle

The normal `docker` onboarding path is:

```text
user profile
-> workspace spec
-> provisioned image
-> rendered backend manifest
-> runtime start
-> daemon ready
-> pairing target ready
```

In repo terms:

```text
apps/polaris/scripts/polaris.ts
-> users/<user>/workspaces/<project>/docker.agent.yaml
-> users/<user>/workspaces/<project>/generated/docker.yaml
-> docker compose runtime
-> status.json + provision.json
```

Generated manifests are rendered artifacts.
They are not hand-maintained source files.

## Recommended Local Flow

Create a user:

```bash
pnpm --dir apps/polaris run polaris -- user create <userProfileId>
```

Create a workspace:

```bash
pnpm --dir apps/polaris run polaris -- create <project> --user <userProfileId>
```

Render and start:

```bash
pnpm --dir apps/polaris run polaris -- render <project>@docker
pnpm --dir apps/polaris run polaris -- start <project>@docker
```

Inspect status:

```bash
pnpm --dir apps/polaris run polaris -- status <project>@docker
pnpm --dir apps/polaris run polaris -- logs <project>@docker
```

## Provisioning Model

Polaris now prefers shared prebuilt image reuse.

The intent is:

- build a shared image once from a workspace Dockerfile digest
- tag it per workspace
- avoid repeated minute-scale rebuilds for equivalent Dockerfiles

Relevant files:

- `apps/polaris/scripts/config/provision.ts`
- `apps/polaris/scripts/config/scaffold.ts`

Useful log events:

- `workspace-shared-image-build`
- `workspace-image-reused`
- `workspace-image-tag`

### Current Behavior

The current implementation already uses the shared image path in normal portal
provisioning.

That means:

- equivalent workspace Dockerfiles are deduplicated by digest
- the shared image is tagged into a workspace image instead of rebuilt
- the slow path is now the exception, not the default

When this path is working, workspace create should move from minute-scale image
rebuilds toward seconds or low tens of seconds for equivalent setups.

### Concrete Files And Flow

The current shared-image path is primarily implemented in:

- `apps/polaris/scripts/config/provision.ts`
- `apps/polaris/scripts/config/scaffold.ts`
- `apps/polaris/scripts/executor/operations.ts`

For a portal-driven create, the concrete flow is:

1. scaffold or load the workspace spec
2. synthesize sibling target specs if needed
3. compute the prebuilt Dockerfile digest
4. look up the shared image for that digest
5. tag the shared image into a workspace image ref
6. continue with render and optional start

What should not happen on the fast path:

- a full rebuild for every equivalent workspace
- a user-visible multi-minute pause before render

## Status Model

Polaris has been moving from deep synchronous probing to cached status plus
active reporting.

### Current Direction

- persist status snapshots under workspace state
- let UI read cached status first
- use explicit refresh for expensive probes
- let runtime components report status patches back to the executor

Relevant files:

- `apps/polaris/scripts/executor/operations.ts`
- `apps/polaris/scripts/executor/server.ts`
- `apps/polaris/scripts/executor/client.ts`
- `apps/polaris/scripts/runtime/status-observer.mjs`
- `apps/polaris/scripts/portal/service.ts`

### Why This Matters

Repeated `docker exec` probes are expensive and unstable.
They slow the UI and create confusing state races.

Cached status plus active reporting gives:

- faster portal reads
- fewer heavy probes
- better mobile behavior
- more stable create/start progress

### Current Behavior

The latest pass changed the portal read path and the executor write path.

In concrete terms:

- workspace detail reads no longer trigger implicit refresh side effects
- create finalization explicitly materializes the final `status.json`
- runtime status observer can report status patches back to the executor
- start, stop, and live credential switch write cached state first, then
  schedule an async refresh

The remaining heavy probe path is now explicit lifecycle work such as:

- final provisioning status capture
- manual refresh
- post-start or post-stop reconciliation refresh

It is no longer the default behavior of every portal detail read.

### Concrete Files And State Files

The current cached-status path is spread across:

- `apps/polaris/scripts/portal/service.ts`
- `apps/polaris/scripts/executor/operations.ts`
- `apps/polaris/scripts/executor/server.ts`
- `apps/polaris/scripts/executor/client.ts`
- `apps/polaris/scripts/runtime/status-observer.mjs`

The key persisted files are:

- `config/users/<user>/workspaces/<workspace>/state/status.json`
- `config/users/<user>/workspaces/<workspace>/state/provision.json`

Current write sources:

- provision finalize writes final `status.json`
- runtime status observer writes status patches through the executor report endpoint
- start / stop / live switch write cached state immediately
- explicit refresh rewrites state from a deep probe

### What To Verify

If this optimization is healthy, the following should all be true:

1. opening workspace detail does not emit new deep probe work by itself
2. `status.json` exists after provisioning completes
3. `workspace-status-reported` appears when observer reporting is active
4. `workspace-status-cached` appears before refresh-completed logs on
   start / stop / live switch paths

## Portal Job Model

Workspace create is no longer only a fire-and-forget mutation.

It should be treated as a job with:

- `jobId`
- `status`
- `phase`
- `percent`
- `startedAt`
- `cancelRequested`
- `cancellable`
- `errorCode`
- `retryable`

State is persisted in:

```text
users/<user>/workspaces/<workspace>/state/provision.json
```

The UI should poll job state, not rely on full-page reloads.

### Current Behavior

The portal create flow now behaves like a resumable job.

It supports:

- persisted `jobId`
- restore after route changes or refresh
- cancel while queued or running
- structured error code handling
- sidebar refresh without forcing a full page reload

Important user-visible changes:

- create/start/stop/delete no longer depend on `window.location.reload()`
- delete navigates locally instead of resetting the full app
- sidebar workspace state is refreshed in place

### Concrete Files

The current portal job behavior is primarily implemented in:

- `apps/polaris-web/src/App.tsx`
- `apps/polaris-web/src/lib/api.ts`
- `apps/polaris/scripts/executor/operations.ts`
- `apps/polaris/scripts/portal/service.ts`

The important state fields now in play are:

- `jobId`
- `status`
- `phase`
- `percent`
- `done`
- `cancelRequested`
- `cancellable`
- `errorCode`
- `retryable`

The intended create UX is now:

1. enqueue create
2. persist `provision.json`
3. poll by workspace detail
4. recover unfinished jobs on reload or route restore
5. surface structured error copy instead of raw backend strings

## Runtime Observer

The runtime status observer runs inside the workspace container.

Its role is to:

- observe daemon availability
- observe pairing availability
- report status patches back to the executor
- support future evolution reporting

For local Docker workspaces, `host.docker.internal` must resolve back to the
host executor.
The Docker render now injects:

- `extra_hosts: host.docker.internal:host-gateway`

The observer is also part of the performance story.

Its status reports reduce the need for repeated synchronous portal-side probing,
especially after the runtime is already up.

## Local Docker Storage Model

For the Docker backend, `netfs.local` is treated specially in local mode.

Instead of requiring a real NFS server on the same host, Polaris can map the
local export path directly into the container as a bind mount.

This avoids:

- host NFS service dependency for local dev
- permission issues on `/exports/...`
- slow or fragile local bootstrap behavior

The host export directory should still be created before the workspace starts.

## Logging And Debugging

If a lifecycle path is wrong, inspect logs in this order:

1. `.tmp/paseo/stack.server.err.log`
2. `.tmp/paseo/stack.executor.err.log`
3. `.tmp/paseo/stack.web.err.log`
4. workspace `status.json`
5. workspace `provision.json`
6. runtime `status-observer.log`
7. runtime `runtime-memory-observer.log`
8. daemon log inside workspace state

Key log events added by the performance work:

- `workspace-provision-queued`
- `workspace-provision-progress`
- `workspace-provision-cancel-requested`
- `workspace-status-cached`
- `workspace-status-reported`
- `workspace-status-refresh-started`
- `workspace-status-refresh-completed`

These logs are intended to answer:

- whether a provision job actually started
- which phase it is in now
- whether cancellation was only requested or already applied
- whether a state change was written from cache or from a deep refresh
- whether runtime status observer reporting is reaching the executor

### Minimal Acceptance Checks

For shared image reuse:

```bash
rg -n "workspace-image-reused|workspace-image-tag" .tmp/paseo/stack.executor.err.log
```

For cached status reads:

```bash
curl -sS http://127.0.0.1:8787/api/users/<user>/workspaces/<workspace> > /tmp/detail-1.json
curl -sS http://127.0.0.1:8787/api/users/<user>/workspaces/<workspace> > /tmp/detail-2.json
```

Then confirm no new implicit refresh work was emitted just because detail was
read.

For observer reporting:

```bash
rg -n "workspace-status-reported" .tmp/paseo/stack.executor.err.log
```

For portal job behavior:

```bash
cat config/users/<user>/workspaces/<workspace>/state/provision.json
cat config/users/<user>/workspaces/<workspace>/state/status.json
```

Useful commands:

```bash
curl -sS http://127.0.0.1:8787/api/users/<user>/workspaces/<workspace>
curl -sS -X POST http://127.0.0.1:8787/api/users/<user>/workspaces/<workspace>/refresh
docker ps
docker exec <container> sh -lc 'env PASEO_HOME=/root/.paseo paseo daemon status --json'
```

For CLI trace output:

```bash
POLARIS_LOG_LEVEL=debug pnpm --dir apps/polaris run polaris -- start <project>@docker
```

## Command Model

Primary commands:

- `user create`
- `create`
- `render`
- `apply`
- `start`
- `stop`
- `restart`
- `rebuild`
- `status`
- `reconcile`
- `logs`
- `switch`
- `live-switch`
- `delete`

## Credentials And Agent Contract

Credential metadata is file-backed:

```text
users/profiles/<user>.yaml
users/<user>/credentials/*.yaml
```

Polaris does not embed a single coding harness.

The contract is:

- Polaris assembles and operates the workspace
- Paseo is the first manager/orchestrator adapter
- Codex, Claude, and other harnesses are external runtimes
- live credential choice is a workspace/runtime concern, not only a user
  preference

## Validation

Minimum local validation:

```bash
pnpm install
pnpm --filter polaris exec tsc -p tsconfig.json --noEmit
pnpm --filter ./apps/polaris-web run build
bash ./scripts/run-polaris-local-stack-service.sh .env.dev
```

Then validate a real portal flow:

```bash
curl -sS -X POST http://127.0.0.1:8787/api/users/<user>/workspaces \
  -H 'content-type: application/json' \
  --data '{"workspaceName":"smoke","defaultDockerOnly":true,"startAfterCreate":true}'
```

Check that the final workspace detail shows:

- `progress.status = completed`
- `status.state = ready`
- `daemon.manager.state = ok`
- `paseo.liveTarget` is present

For the optimized path, also verify:

- repeated detail reads do not trigger extra command-side refresh work
- shared-image logs appear when Dockerfiles are equivalent
- `workspace-status-reported` appears when runtime status observer reporting is active
- create flow can recover an unfinished job without a full page reset

## Related Docs

- [../CHANGELOG.md](../CHANGELOG.md)
- [isolation-maturity.md](./isolation-maturity.md)
- [agent-swarm-maturity.md](./agent-swarm-maturity.md)
- [evolution-maturity.md](./evolution-maturity.md)
- [user-management-maturity.md](./user-management-maturity.md)
