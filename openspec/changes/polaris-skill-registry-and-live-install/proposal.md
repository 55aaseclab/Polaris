## Why

Polaris already manages user-owned credentials and live workspace runtime
state, but it has no first-class model for reusable skills. We need a small,
declarative skill registry plus workspace-level live install flows so admins
can manage skills without turning user homes into another source of truth.

## What Changes

- Add user-scoped skill registry commands to list, add, and remove skill
  references without downloading or installing them.
- Store skill references in an `npx`-compatible source format so workspace
  install flows can reconstruct the installer command later.
- Add workspace skill commands to list installed skills, live-install skills,
  live-uninstall skills, and sync workspace installs to the user's registry.
- Add server endpoints and shared control-plane services for user skill
  registry reads and workspace live skill actions.
- Add an admin user Skills tab in the Polaris web portal.
- Add workspace skill action buttons in the Polaris web portal for live
  install, live uninstall, and sync.

## Capabilities

### New Capabilities
- `user-skill-registry`: user-owned skill references stored as declarative
  install descriptors.
- `workspace-live-skills`: workspace-level skill install, uninstall, list, and
  sync flows driven from the user registry.
- `workspace-skill-portal`: admin and workspace portal surfaces for skill
  registry and live skill actions.

### Modified Capabilities

- None.

## Impact

- `apps/polaris/scripts/cli` gains `user skill` and `ws skill` command groups.
- `apps/polaris/scripts/portal` gains skill registry and workspace live skill
  API endpoints.
- `apps/polaris/scripts/executor` gains runtime materialization logic for
  workspace skill install and uninstall.
- `apps/polaris-web` gains an admin Skills tab and workspace skill action
  controls.
