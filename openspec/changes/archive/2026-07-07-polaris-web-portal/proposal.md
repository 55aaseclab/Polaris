## Why

Polaris already owns workspace config, credentials, backend switching, and live
status, but it only exposes that control plane through a CLI. A user-based web
portal will make credentials, workspaces, driver switching, and provisioning
available through an authenticated UI without creating a second source of
truth.

## What Changes

- Add a user-based web portal inside `apps/polaris`.
- Use Clerk for authentication and route access by explicit
  `/users/<user_id>/workspaces/<workspace_name>` paths.
- Let normal users access only their own workspaces and let admins access
  other users.
- Provide workspace pages for status, backend selection, driver switching, and
  current runtime links.
- Provide user pages for credential management.
- Make workspace creation a blocking provisioning flow that creates all
  supported driver specs and required images before the workspace is usable.
- Keep Polaris config directories and runtime state as the source of truth.

## Capabilities

### New Capabilities
- `workspace-portal`: authenticated web portal for user-owned workspaces,
  credentials, provisioning, and driver switching.

### Modified Capabilities

- None.

## Impact

- `apps/polaris` gains a web UI/API surface on top of the existing control
  plane.
- Clerk becomes the external auth dependency for portal sessions.
- Portal routes and authorization must align with
  `config/users/<user>/projects/<workspace>/`.
- Workspace provisioning must coordinate specs, manifests, and image builds
  before completion.
