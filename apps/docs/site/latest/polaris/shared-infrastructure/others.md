# Other Shared Infrastructure Notes

This page keeps the shared-infrastructure material that is still mainly
technical.

## Runtime Observer

The runtime status observer runs inside the workspace container.

Its role is to:

- observe daemon availability
- observe pairing availability
- report status patches back to the executor
- support future evolution reporting

For local Docker workspaces, `host.docker.internal` must resolve back to the
host executor.

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

1. `.tmp/paseo/stack.server.err.log`
2. `.tmp/paseo/stack.executor.err.log`
3. `.tmp/paseo/stack.web.err.log`
4. workspace `status.json`
5. workspace `provision.json`
6. runtime `status-observer.log`
7. runtime `runtime-memory-observer.log`
8. daemon log inside workspace state

Key log events include:

- `workspace-provision-queued`
- `workspace-provision-progress`
- `workspace-provision-cancel-requested`
- `workspace-status-cached`
- `workspace-status-reported`
- `workspace-status-refresh-started`
- `workspace-status-refresh-completed`

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
