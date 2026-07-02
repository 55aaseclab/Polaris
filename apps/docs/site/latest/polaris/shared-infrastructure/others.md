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

The local stack wrapper now starts an executor bridge proxy on the Docker
bridge IP and forwards it to the host-local executor on `127.0.0.1:8788`.

That bridge is what lets the runtime status observer push persisted Paseo
`server-id` and `pairing.json` metadata back into the host workspace state.

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
