## Context

The portal currently uses mixed workspace summary payloads and recurring
polling loops to keep sidebar state, admin workspace lists, and workspace
detail pages fresh. The same `PortalWorkspaceSummary` shape currently mixes
workspace inventory, live driver state, Paseo connection state, and detail-only
fields. That forces `PortalShell` to act as both a workspace inventory loader
and a live state repair loop, while detail pages still run their own polling to
close freshness gaps.

The source of truth for live workspace state is already filesystem-backed:
workspace status is persisted under user workspace state directories, and
executor workflows update those files as lifecycle operations progress. The
portal and executor run as separate processes, so an in-memory event bus alone
cannot deliver complete live updates. A filesystem-observed stream aligns with
the existing status model and captures executor-driven, portal-driven, and
external CLI-driven status changes without adding a new cross-process broker.

This change affects both the portal backend and the Polaris web app. It also
changes the frontend center of gravity from a mixed workspace summary array to
a reusable user-scoped `UserWorkspaceStore`.

## Goals / Non-Goals

**Goals:**
- Replace portal polling for driver and Paseo state with a user-scoped live
  stream driven by filesystem observation.
- Split workspace data contracts into static workspace inventory, live
  workspace summaries, and detail-static workspace payloads.
- Make `UserWorkspaceStore` the shared frontend abstraction for user-scoped
  workspace inventory and live state.
- Migrate `PortalShell` fully to the new static and live interfaces instead of
  continuing to bootstrap from the legacy mixed `/workspaces` response.
- Let workspace detail pages consume shared live state instead of running
  recurring status polling loops.
- Reuse the same static/live model for admin workspace views, with a separate
  user-scoped store instance for the selected admin target user.

**Non-Goals:**
- Replacing workspace status files as the canonical live status source.
- Introducing WebSocket transport or a new external event broker.
- Reworking workspace credential, asset, or assembly semantics beyond moving
  those fields into detail-static payloads.
- Eliminating all manual refresh actions; explicit refresh operations may still
  exist as user-triggered control-plane actions.

## Decisions

### Decision: Treat `WorkspaceStatus` as the live source of truth and stream a narrowed projection

The portal will continue to treat persisted workspace status as the canonical
live state source. The live stream will not expose the entire status file
verbatim. Instead, the backend will project each workspace into a narrowed
`PortalWorkspaceLiveSummary` shape that includes only driver, Paseo, and other
list/detail-live fields needed by the UI.

Rationale:
- Status files already capture the state transitions that the UI needs.
- Narrowing the streamed payload avoids coupling browser contracts to the full
  disk schema and prevents large detail fields from flowing through high-rate
  updates.
- It keeps live stream recomputation cheap: read status, normalize, project,
  diff, emit.

Alternatives considered:
- Stream the entire `WorkspaceStatus` file. Rejected because it keeps frontend
  contracts tightly coupled to disk schema and increases payload size.
- Recompute live state directly from backend drivers during streaming.
  Rejected because it reintroduces expensive active observation and defeats the
  point of reducing traffic and control-plane churn.

### Decision: Split portal workspace APIs into static, live, and detail-static interfaces

The portal will expose three distinct workspace data contracts:
- static workspace inventory for user-scoped lists
- live workspace summaries via a stream
- detail-static workspace payloads for workspace pages

`PortalShell` will stop using the legacy mixed `/workspaces` interface and
instead bootstrap from the static inventory plus the live stream.

Rationale:
- It aligns data ownership with actual refresh behavior.
- Sidebar and admin lists need fast live updates but not detail-only payloads.
- Detail pages need assets, bindings, and assembly data, but those fields do
  not belong in every live update.

Alternatives considered:
- Keep the legacy mixed list as the bootstrap payload and patch it with live
  deltas. Rejected because it preserves the overfat summary type and continues
  to blur static and live boundaries.
- Add only a live stream and leave detail pages on mixed summary + polling.
  Rejected because it leaves the current ownership split and refresh hacks in
  place.

### Decision: Make `UserWorkspaceStore` the frontend center of gravity

The web app will introduce a reusable user-scoped `UserWorkspaceStore` that
owns:
- static workspace inventory
- live workspace summaries keyed by workspace name
- live stream connection state

`PortalShell` will own one instance for the active route-scoped user. Admin
workspace views will reuse the same store model with their own selected-user
instance instead of reusing `PortalShell` state directly.

Rationale:
- The current `PortalWorkspaceSummary[]` array is doing too much.
- A named store makes the split between inventory and live state explicit.
- Admin target-user views are user-scoped consumers, but not the same scoped
  user as the shell.

Alternatives considered:
- Keep a single shell context with one `workspaces` array. Rejected because it
  encourages continued mixing of static and live concerns.
- Force admin selected-user state into the same shell store. Rejected because
  it complicates shell ownership and route-scope assumptions.

### Decision: Use filesystem observation with debounce-and-diff semantics

The portal backend will observe user workspace directories and workspace state
files, mark affected users/workspaces dirty, and recompute canonical snapshots
after a short debounce window. Subscribers receive an initial snapshot, then
workspace-level upsert/remove events.

The watcher model will cover:
- workspace inventory changes
- driver-spec availability changes
- workspace status file changes

Rationale:
- Portal and executor are separate processes, so file observation captures all
  status writers.
- `fs.watch` is good enough as an invalidation trigger when paired with
  snapshot recomputation, debounce, and diffing.
- Workspace-level diffs keep event payloads smaller than republishing full user
  workspace lists.

Alternatives considered:
- Cross-process event publication from executor to portal. Rejected for now
  because it adds a new reliability surface and still would not capture changes
  made outside executor workflows.
- Pure periodic polling from the browser. Rejected because it is the current
  traffic-heavy behavior being removed.

## Risks / Trade-offs

- **[Watcher event noise or missed low-level details]** → Treat watcher signals
  as invalidation only, then rescan and diff canonical snapshots instead of
  relying on raw file events.
- **[Short window where static inventory is loaded before live state arrives]**
  → Define an explicit "unknown" live status UI state and do not block sidebar
  rendering on live connection establishment.
- **[Legacy callers continue using mixed `/workspaces` payloads]** → Migrate
  `PortalShell` fully to new interfaces and keep new types separate from
  `PortalWorkspaceSummary` so accidental reuse is obvious.
- **[Live stream transport and auth mismatch]** → Use a fetch-based
  server-sent event stream shape so the portal can continue using the same
  authorization model as other authenticated API requests.
- **[Admin views duplicate shell logic]** → Reuse a single `UserWorkspaceStore`
  model while keeping store instances user-scoped to their owner.

## Migration Plan

1. Introduce backend projections and APIs for static workspace inventory,
   detail-static workspace payloads, and live workspace streaming without
   changing existing shell consumers yet.
2. Add portal-side user-scoped watcher hubs and live stream endpoints backed by
   filesystem observation and workspace-level diffs.
3. Introduce `UserWorkspaceStore` in the web app and migrate `PortalShell`
   fully to the new static and live interfaces.
4. Update workspace detail pages to load detail-static data once and read live
   driver and Paseo state from the shared user-scoped store.
5. Update admin selected-user workspace views to use the same store model and
   remove transient list polling.
6. Remove obsolete polling loops and legacy shell dependencies on mixed
   workspace summary payloads.

Rollback:
- Keep the legacy mixed workspace list endpoint available until all shell and
  admin consumers have migrated.
- If watcher-backed streaming proves unstable, the browser can temporarily fall
  back to existing explicit refresh actions while the new interfaces remain in
  place.

## Open Questions

- Should the legacy mixed `/workspaces` endpoint be retained temporarily for
  non-shell callers, or should all portal callers migrate in the same change?
- How long should idle watcher hubs stay alive after the last subscriber
  disconnects?
- Should live summaries include any normalized operation field beyond
  `driver.status`, or should transition latching remain a frontend-only concern
  after migration?
