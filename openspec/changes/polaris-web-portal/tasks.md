## 1. Shared control plane

- [x] 1.1 Extract shared workspace ownership, status, and driver resolution
  helpers for portal and CLI reuse.
- [x] 1.2 Add a Clerk session-to-user mapping layer that resolves the portal
  route user id before any workspace action.
- [x] 1.3 Add self-only and admin cross-user authorization checks around the
  explicit `/users/<user_id>/workspaces/<workspace_name>` route.

## 2. Portal data and API

- [x] 2.1 Add portal API endpoints for owned workspace listing, workspace
  status, credential listing, and driver selection.
- [x] 2.2 Add a portal API response shape that exposes current backend, current
  runtime access target, and provisioning progress.
- [x] 2.3 Add portal API handlers for credential create/update/list operations
  scoped to the authenticated user.

## 3. Portal UI

- [x] 3.1 Add the portal shell and route structure under `apps/polaris`.
- [x] 3.2 Add a user workspace index page that lists owned workspaces and
  current status.
- [x] 3.3 Add a workspace detail page that shows runtime state, backend choice,
  live access target, and driver switch actions.
- [x] 3.4 Add a credentials page for user-owned credentials and workspace
  bindings.

## 4. Provisioning and switching

- [x] 4.1 Add a blocking workspace creation flow that provisions all driver
  specs, generated manifests, and required images before completion.
- [x] 4.2 Add resumable progress reporting for provisioning so users can leave
  and return later.
- [x] 4.3 Wire driver switching to the existing Polaris backend model for
  `docker`, `pod:gvisor`, `pod:data-container`, and `kubevirt-vm`.
- [x] 4.4 Add tests that cover self-only access, admin access, workspace
  ownership resolution, credential scoping, and provisioning progress.
