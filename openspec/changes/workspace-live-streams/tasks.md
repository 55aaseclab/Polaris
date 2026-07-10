## 1. Backend projections and APIs

- [x] 1.1 Add explicit portal workspace projection types for static summaries,
  live summaries, and detail-static payloads
- [x] 1.2 Implement portal helpers that read static workspace inventory without
  depending on live status files
- [x] 1.3 Implement portal helpers that project persisted workspace status into
  narrowed live workspace summaries
- [x] 1.4 Implement a detail-static workspace loader for bindings, assets,
  attachments, and workspace assembly data
- [x] 1.5 Add portal HTTP endpoints for static workspace inventory,
  detail-static workspace payloads, and user-scoped live workspace streaming

## 2. Filesystem-observed live streaming

- [x] 2.1 Add a user-scoped watcher hub that observes workspace inventory and
  workspace status file changes
- [x] 2.2 Implement debounce-and-diff recomputation for inventory and live
  workspace updates
- [x] 2.3 Implement stream event serialization for initial snapshots,
  workspace upserts, removals, and heartbeats
- [x] 2.4 Add subscriber lifecycle handling, idle watcher cleanup, and stream
  authorization checks

## 3. Frontend UserWorkspaceStore

- [x] 3.1 Add frontend API clients for static workspace inventory,
  detail-static workspace payloads, and authenticated live workspace streaming
- [x] 3.2 Implement a reusable user-scoped `UserWorkspaceStore` that keeps
  static inventory, live workspace summaries, and stream connection state
- [x] 3.3 Add reducers or merge helpers for snapshot, static update, live
  update, and workspace removal events
- [x] 3.4 Keep embedded Paseo iframe caching separate from the
  `UserWorkspaceStore` data model

## 4. PortalShell and page migrations

- [x] 4.1 Migrate `PortalShell` to bootstrap entirely from static inventory and
  the live workspace stream
- [x] 4.2 Update sidebar and workspace index views to consume static inventory
  plus live workspace summaries instead of mixed workspace summary arrays
- [x] 4.3 Update workspace detail pages to fetch detail-static payloads once
  and consume live driver and Paseo state from the shared shell store
- [x] 4.4 Remove recurring workspace detail polling loops and stale
  summary-to-detail refresh bridge logic
- [x] 4.5 Update admin selected-user workspace views to use the same new
  static/live model with their own user-scoped workspace store instance

## 5. Cleanup and verification

- [x] 5.1 Remove obsolete shell dependencies on the legacy mixed
  `/workspaces` response where the new interfaces fully replace them
- [x] 5.2 Add backend tests for workspace live projection, watcher diffing, and
  stream event behavior
- [x] 5.3 Add frontend tests for `UserWorkspaceStore`, `PortalShell`
  consumption, and detail/admin migration paths
- [x] 5.4 Validate that sidebar, detail, and admin workspace views converge on
  streamed updates without background polling
