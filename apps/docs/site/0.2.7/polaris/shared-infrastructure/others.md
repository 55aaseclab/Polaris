# Other Shared Infrastructure Notes

This page keeps the shared-infrastructure material that is still mainly
technical.

## Workspace Runtime Status Surface

Polaris now keeps workspace runtime status as shared infrastructure, not as an
agent-swarm concept.

The current model is:

- `status.json` is the cached runtime-facing status surface
- reconnect metadata comes from `state/paseo/server-id` and
  `state/paseo/pairing.json`
- runtime lifecycle and Paseo connectivity are separate blocks
- explicit refresh still exists, but cached status is the primary read path

Polaris now combines:

- backend observation
- runtime assembly checks
- persisted runtime selection

Recent narrowing also means:

- `status.json` is no longer the place to invent extra daemon semantics
- portal detail reads prefer cached workspace status
- workspace ready gating no longer depends on `paseo daemon status`
- start, stop, and switch paths may write cached lifecycle first and then
  refresh asynchronously
- user-visible lifecycle no longer depends on a separate provisioning progress
  file

Key files:

- `apps/polaris/scripts/executor/operations.ts`
- `apps/polaris/scripts/runtime/status-observer.mjs`
- `apps/polaris-web/src/App.tsx`

## Runtime Credential Switching

Runtime credential switching also belongs to shared infrastructure.

It does not change the daemon type.

It does not rebuild the user profile.

The current flow is:

- read the target user credential
- validate that the credential belongs to the requested harness
- write credential material into `user-identity-state`
- record the current live selection by harness
- refresh cached status so the runtime selection becomes visible

Current live-switch harnesses:

- `ssh`
- `codex`
- `claude`
- `copilot`
- `opencode`
- `pi`

Recent UX optimization:

- write the current cached harness selection first
- then trigger async status refresh

That lets the UI reflect the credential switch before a full deep probe
finishes.

Validation should check both:

- whether the UI switches to the new selection immediately
- whether the later refresh stabilizes the selection state

## Runtime Selection And Status Semantics

### live target

`liveTarget` is the current pairing URL exposed by the workspace.

It describes the connection entry point.

It does not describe:

- which harness is currently in use
- which credential is currently selected

### supported harnesses

`supportedHarnesses` is the harness set that the current runtime can support.

It describes capability.

It does not describe:

- whether every harness already has credentials
- whether every harness already has a live selection

### credential status

Credential state is now split into two layers:

1. user-level default or workspace-bound resolution
2. per-harness runtime live selection

The status surface may include:

- `codex.state`
- `codex.source`
- `live.switchableHarnesses`
- `live.supportedHarnesses`
- `live.selectedHarness`
- `live.selectedCredentialId`
- `live.selectedCredentialLabel`
- `live.selectedByHarness`

That means Polaris no longer exposes only one generic "current agent
credential".

It exposes a harness-scoped runtime selection view.

## Runtime Observer

The runtime status observer runs inside the workspace container.

Its role is to:

- report status patches back to the executor
- support future evolution reporting

For local Docker workspaces, `host.docker.internal` must resolve back to the
host executor.

The local stack wrapper now starts an executor bridge proxy on the Docker
bridge IP and forwards it to the host-local executor on `127.0.0.1:8788`.

Paseo reconnect metadata no longer depends on the runtime observer.

Workspace start/bootstrap writes:

- `state/paseo/server-id`
- `state/paseo/pairing.json`

The observer only reports the workspace lifecycle heartbeat.

## Local Docker Storage Model

For the Docker backend, `netfs.local` is treated specially in local mode.

Instead of requiring a real NFS server on the same host, Polaris can map the
local export path directly into the container as a bind mount.

This avoids:

- host NFS service dependency for local development
- permission issues on `/exports/...`
- slow local bootstrap behavior

## Status, Logging, And Debugging

If a lifecycle path is wrong, inspect logs in this order:

1. `.runtime/paseo/stack.server.err.log`
2. `.runtime/paseo/stack.executor.err.log`
3. `.runtime/paseo/stack.web.err.log`
4. workspace `status.json`
5. runtime `status-observer.log`
6. runtime `runtime-memory-observer.log`
7. daemon log inside workspace state

Key log events include:

- `workspace-status-cached`
- `workspace-status-reported`
- `workspace-status-refresh-started`
- `workspace-status-refresh-completed`

Polaris should debug workspace lifecycle from `status.json` and runtime logs,
not from a separate provisioning progress file.

## Docker Compose Isolation

Docker workspaces now render a unique compose `name:` based on
`userId-workspace`.

This matters because archive and delete paths run:

- `docker compose ... down -v --remove-orphans`

Without a unique compose project name, one workspace teardown could remove a
different workspace container that happened to share the same default Compose
project identity.

## Workspace Runtime Command Notes

The broader runtime command surface still includes:

- `render`
- `apply`
- `restart`
- `rebuild`
- `reconcile`
- `logs`
- `switch`
- `live-switch`
