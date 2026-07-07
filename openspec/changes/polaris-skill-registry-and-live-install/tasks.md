## 1. User skill registry

- [x] 1.1 Add a persisted user skill registry model and list/add/remove helper
  functions under the Polaris config layer.
- [x] 1.2 Add `polaris user skill list`, `add`, and `remove` CLI commands with
  validation for the registry descriptor format.
- [x] 1.3 Add tests for duplicate handling, missing user behavior, and
  registry serialization.

## 2. Workspace live skill materialization

- [x] 2.1 Add workspace skill state helpers that read installed skills by
  harness and resolve registry entries for install actions.
- [x] 2.2 Add executor operations for `ws skill list`, `live-install`,
  `live-uninstall`, and `sync`, with Codex-first runtime projection.
- [x] 2.3 Add CLI commands for the workspace skill flows and tests for install,
  uninstall, missing registry entries, and sync reconciliation.

## 3. Portal server and services

- [x] 3.1 Add portal service methods and HTTP endpoints for user skill list,
  add, and remove operations.
- [x] 3.2 Add portal service methods and HTTP endpoints for workspace skill
  list, live install, live uninstall, and sync actions.
- [x] 3.3 Add API response shapes and service tests that cover admin-scoped
  user access and workspace action failures.

## 4. Portal UI

- [x] 4.1 Add an admin user Skills tab that lists registry entries and supports
  add and remove actions.
- [x] 4.2 Add workspace skill controls for list, live install, live uninstall,
  and sync in the existing workspace detail view.
- [x] 4.3 Add frontend API bindings, interaction states, and end-to-end or
  component coverage for the new skill flows.
