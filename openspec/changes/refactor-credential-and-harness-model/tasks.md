## 1. Credential Lifecycle Foundation

- [x] 1.1 Extract a shared credential service that owns SSH and Codex
  credential create, delete, list, and activation behavior.
- [x] 1.2 Move SSH key generation and SSH registry creation into the shared
  credential service.
- [x] 1.3 Update `user create` to provision only profile-required credentials
  through the shared credential service.
- [x] 1.4 Update `user delete` to remove managed credentials through the shared
  credential service instead of direct ad hoc cleanup.
- [x] 1.5 Extend the credential CLI surface to support add, delete, list, and
  activate operations for user credentials.

## 2. Workspace And Runtime Decoupling

- [x] 2.1 Remove implicit default Codex credential creation from workspace
  scaffolding.
- [x] 2.2 Introduce a shared harness tool catalog for `codex`, `claude`,
  `copilot`, `opencode`, and `pi`.
- [x] 2.3 Update Docker and pod runtime bootstrap flows to provision harness
  tooling from the shared tool catalog.
- [x] 2.4 Update runtime assembly to mount the active user Codex credential
  into standard Codex paths without treating missing credentials as missing
  tooling.
- [x] 2.5 Remove credential-driven infrastructure toggling from the current
  workspace Paseo bind or unbind flow and keep only bounded compatibility
  behavior where needed.

## 3. Portal And UI Flows

- [x] 3.1 Update portal credential APIs to expose user-level add, delete, list,
  and activate behavior.
- [x] 3.2 Update the credential UI to add, delete, and switch Codex
  credentials, starting with a RightCode template.
- [x] 3.3 Update workspace and Paseo UI text so daemon and harness status are
  reported separately from credential state.
- [x] 3.4 Decide and document how the current workspace bind or unbind routes
  remain available as compatibility behavior during migration.

## 4. Migration, Tests, And Docs

- [x] 4.1 Update fixtures, sample data, and scaffolding assumptions that depend
  on implicit default Codex credential creation.
- [x] 4.2 Add tests for SSH provisioning during user creation, Codex credential
  add/delete/activate flows, and runtime assembly of active Codex credentials.
- [x] 4.3 Add tests that verify daemon and harness status remain available when
  no active Codex credential is selected.
- [x] 4.4 Update `docs/polaris/portal-business-flow.md` and related docs to
  reflect the decoupled daemon, harness, and credential model.
