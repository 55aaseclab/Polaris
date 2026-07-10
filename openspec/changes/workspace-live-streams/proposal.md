## Why

The portal currently polls mixed workspace summary payloads to keep sidebar,
admin workspace lists, and workspace detail pages up to date. That wastes
traffic, keeps static and live data coupled together, and forces page-specific
refresh loops to compensate for stale state.

## What Changes

- Replace workspace polling for driver and Paseo state with a user-scoped live
  stream backed by filesystem observation of workspace state files.
- Split portal workspace data into three explicit views:
  static workspace summaries, live workspace summaries, and detail-static
  workspace payloads.
- Introduce a reusable `UserWorkspaceStore` model in the web app so
  `PortalShell` and other user-scoped views consume the same static/live
  workspace contract instead of a mixed `PortalWorkspaceSummary[]` payload.
- Migrate `PortalShell` completely to the new static list and live stream
  interfaces instead of continuing to bootstrap from the legacy mixed
  `/workspaces` response.
- Update workspace detail pages to read live driver and Paseo state from the
  shared `UserWorkspaceStore` and stop running recurring status polling loops.
- Update admin user workspace views to use the same new interfaces with their
  own user-scoped workspace store instead of transient whole-list polling.

## Capabilities

### New Capabilities
- `workspace-live-streaming`: User-scoped live workspace summaries streamed from
  portal filesystem observation, including canonical driver and Paseo live
  state updates.
- `user-workspace-store`: Frontend user-scoped workspace store that separates
  static workspace inventory from live workspace state and exposes shared
  consumption patterns for shell and admin views.

### Modified Capabilities
- `workspace-portal`: Workspace portal routes and UI data contracts change from
  mixed workspace summaries and polling loops to explicit static, live, and
  detail-static interfaces.

## Impact

- Affected code:
  `apps/polaris-web/src/App.tsx`,
  `apps/polaris-web/src/lib/api.ts`,
  `apps/polaris/scripts/core/portal.ts`,
  `apps/polaris/scripts/portal/server.ts`,
  `apps/polaris/scripts/portal/service.ts`
- New portal APIs for static workspace inventory, detail-static payloads, and
  live workspace streaming
- New portal-side filesystem watch and diff/broadcast service keyed by user
- UI state management changes for sidebar, workspace detail, and admin
  workspace views
