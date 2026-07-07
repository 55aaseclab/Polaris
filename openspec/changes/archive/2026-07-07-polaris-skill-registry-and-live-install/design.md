## Context

Polaris already separates user-owned credentials from workspace runtime state.
Skills need the same split, but with a different materialization rule.
Credentials are secret material that Polaris writes into runtime identity
state. Skills are install descriptors that should stay declarative at the user
level and only become files when a workspace asks for them.

The requested command surface is:

- `polaris user skill list <user>`
- `polaris user skill add <user> ...`
- `polaris user skill remove <user> <skillId>`
- `polaris ws skill list <ws>`
- `polaris ws skill live-install <ws> <skillId> --harness codex`
- `polaris ws skill live-uninstall <ws> <skillId> --harness codex`
- `polaris ws skill sync <ws>`

The portal also needs two new surfaces:

- an admin user Skills tab for registry management
- workspace buttons for live install, live uninstall, and sync

## Goals / Non-Goals

**Goals:**
- Add a user skill registry that stores install descriptors but does not
  download or install skill contents.
- Add workspace-level materialization flows that install or remove skill files
  from the workspace runtime on demand.
- Support the new CLI surface through shared services so the portal and CLI do
  not drift.
- Expose registry management in the admin user view and workspace live actions
  in the portal.
- Keep the first version narrow and Codex-first for runtime installation.

**Non-Goals:**
- Install skills into a user's global assistant home.
- Add team-shared or organization-wide skill ownership.
- Support every harness equally in the first version.
- Build a general remote package cache for downloaded skill sources.

## Decisions

- Store user skills as declarative registry entries under the Polaris user
  tree, not as installed files. This keeps user state small and avoids
  coupling Polaris user assets to host assistant homes.
- Record each skill entry as an `npx`-compatible install descriptor. The
  registry will preserve enough structured data to rebuild the installer
  command for workspace materialization instead of storing extracted skill
  files.
- Make the workspace the only materialization boundary. `live-install`,
  `live-uninstall`, and `sync` will read from the user registry and then write
  the workspace's assistant skill directory.
- Start with a Codex projector for runtime install paths. The command surface
  stays harness-aware, but the first implementation only guarantees runtime
  behavior for `codex`.
- Reuse the existing control-plane split: config helpers own persistence, CLI
  commands own argument parsing, portal services own user-facing orchestration,
  and executor operations own live runtime mutation.
- Treat `ws skill sync` as reconciliation from declared registry state to the
  workspace's installed state. It installs missing registry skills and removes
  unmanaged ones for the selected harness set.
- Add server endpoints that mirror the CLI operations instead of teaching the
  frontend to compose shell commands.

## Risks / Trade-offs

- [Risk] `npx` install descriptor shape may evolve across upstream tools →
  Mitigation: store explicit source fields plus the reconstructed command
  inputs instead of a brittle opaque string only.
- [Risk] Live install can succeed on disk but not become visible to a running
  session immediately → Mitigation: return a status field that distinguishes
  installed state from session-refresh state.
- [Risk] Workspace sync can remove manually-added runtime skills → Mitigation:
  define sync as full reconciliation and surface a clear confirmation in the
  portal before destructive actions.
- [Risk] Future harnesses may need different install layouts →
  Mitigation: isolate runtime materialization behind harness-specific
  projectors and ship Codex first.

## Migration Plan

- Add the user registry format and CLI commands without changing existing user
  or workspace config.
- Add workspace runtime state tracking for installed skills.
- Add portal APIs and frontend surfaces after the shared services exist.
- Rollback by removing skill registry files and workspace-installed skill
  directories. Existing credential and workspace flows remain unchanged.

## Open Questions

- Which exact `npx` source fields should be first-class in the registry:
  package name plus args, or a raw install command plus parsed metadata?
- Should workspace sync be exposed for all workspace pages immediately or only
  for admin-scoped views in the first release?
- Should `live-install` reject non-running workspaces, or install into
  persistent workspace state and defer session visibility until the next start?
