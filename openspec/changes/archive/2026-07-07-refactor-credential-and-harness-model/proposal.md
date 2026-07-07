## Why

Polaris currently mixes three different concerns: Paseo daemon lifecycle,
installed agent harnesses, and user credential selection. That coupling makes
credential binding look like an agent enable or disable switch, even though the
daemon and harness CLIs are really infrastructure concerns.

The user model is also inconsistent. `user create` currently scaffolds SSH
material directly, while default Codex credentials are created later as a side
effect of workspace scaffolding. That makes credential ownership unclear and
prevents a clean user-level workflow for adding, deleting, and switching
providers.

## What Changes

- Decouple Paseo daemon startup and harness availability from credential
  selection.
- Introduce a user-level credential management flow built around add, delete,
  list, and activate operations.
- Make `user create` create only the credentials required by the user profile.
  For now, that means SSH only.
- Move SSH key generation under the credential creation path instead of keeping
  it as a separate user scaffolding concern.
- Stop auto-creating default Codex credentials during workspace scaffolding.
- Add a first-class harness catalog for workspace tooling, starting with
  `codex`, `claude`, `copilot`, `opencode`, and `pi`.
- Update the credential UI so users can add, delete, and switch Codex
  credentials. The first provider template will be RightCode for Codex.
- Re-scope workspace credential binding so it is no longer treated as the
  switch that enables or disables agent infrastructure.
- **BREAKING** Workspace credential binding semantics will change. Binding a
  credential will no longer imply turning Paseo or agent infrastructure on or
  off.
- **BREAKING** Workspace scaffolding will no longer create a default Codex
  credential implicitly.

## Capabilities

### New Capabilities

- `user-credential-management`: Define user-level credential lifecycle,
  required credential scaffolding from the user profile, active credential
  selection, and provider-template-based credential creation.

### Modified Capabilities

- `attachment-config-schema`: Credential-backed identity material must be
  declared through explicit user credential records instead of mixed user
  scaffolding side effects.
- `workspace-orchestration`: Workspace startup, Paseo daemon handling, and
  harness installation must remain available without treating credential
  binding as an infrastructure toggle.
- `workspace-runtime-contract`: Runtime assembly must mount active user
  credentials into standard harness paths while keeping daemon and harness
  status independent from credential activation.
- `workspace-runtime-controller`: Reported Paseo and harness status must no
  longer describe credential binding as agent enable or disable state.

## Impact

- Affected code includes `apps/polaris/scripts/config/`,
  `apps/polaris/scripts/cli/commands/`, executor and portal credential flows,
  workspace renderers, and `apps/polaris-web`.
- Affected APIs include user creation, user deletion, credential CRUD, and the
  current workspace Paseo bind or unbind routes.
- Affected persisted data includes user credential registry files, user SSH
  material, workspace specs, and any default credential assumptions in
  generated workspace configs.
- This change will likely require updates to
  `docs/polaris/portal-business-flow.md` and related operational
  documentation.
