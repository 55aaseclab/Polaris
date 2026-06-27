## Why

Polaris currently treats credentials as a narrow Codex-only flow and mixes
credential concerns with driver and Paseo status concerns. We now need a
first-class multi-harness credential model so users can manage SSH, Codex,
Claude, Copilot, OpenCode, and pi credentials explicitly and switch the live
workspace Codex-family credential without coupling that action to driver or
daemon lifecycle.

## What Changes

- Add grouped user credential management for multiple harness families in the
  Polaris web portal.
- Expand the credential model and CLI so user-scoped credentials can represent
  SSH, Codex, Claude, Copilot, OpenCode, and pi entries with harness-aware
  metadata.
- Rework the credentials page into harness-specific sections with table-based
  management, row-level delete actions, and add actions backed by reusable
  provider templates.
- Introduce a workspace live credential switch path for Codex-family harnesses
  that updates the runtime `.codex` material used by the selected workspace
  without coupling the action to driver switching or Paseo daemon state.
- Reuse Codex provider template data and live-file semantics from `cc-switch`
  where practical, while keeping Polaris as the source of truth for user
  credential records.

## Capabilities

### New Capabilities

- `user-credential-management`: Manage user-scoped credentials by harness
  family, create them from reusable templates, and delete them from the portal
  and CLI.
- `workspace-harness-credential-switch`: Switch the live Codex-family
  credential material for a workspace runtime independently of driver and
  Paseo daemon lifecycle.

### Modified Capabilities

- `workspace-runtime-controller`: Expose enough runtime credential status for
  the portal to display harness-aware selection controls and live switch state.

## Impact

- Affected code:
  `apps/polaris-web/src/App.tsx`,
  `apps/polaris-web/src/lib/api.ts`,
  `apps/polaris/scripts/config/credentials.ts`,
  `apps/polaris/scripts/cli/commands/user-credential.ts`,
  `apps/polaris/scripts/portal/service.ts`,
  `apps/polaris/scripts/portal/server.ts`,
  `apps/polaris/scripts/core/runtime-controller.ts`,
  driver-specific runtime mutation paths under `apps/polaris/scripts/backends/`.
- Affected UX:
  Credentials page, Paseo status page.
- External reuse:
  Snapshot Codex preset/template data from `cc-switch` and document the source
  commit used for synchronization.
