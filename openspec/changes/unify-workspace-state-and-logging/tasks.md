## 1. Canonical State Contract

- [x] 1.1 Define the canonical workspace lifecycle and readiness schema in the
  Polaris workspace core types.
- [x] 1.2 Remove or deprecate duplicated persisted status fields that do not
  represent unique control-plane truth.
- [x] 1.3 Add unit coverage for canonical state resolution inputs and expected
  lifecycle outputs.

## 2. Backend State Resolution

- [x] 2.1 Refactor backend observation and runtime-controller synthesis to feed
  one canonical workspace state resolver.
- [x] 2.2 Update executor lifecycle operations to set and clear in-flight
  action markers through the shared resolver instead of ad hoc partial writes.
- [x] 2.3 Replace merge-heavy status persistence paths with validated canonical
  status writes.

## 3. Portal State Consumption

- [x] 3.1 Update portal summary and detail loaders to consume the canonical
  workspace state contract.
- [x] 3.2 Centralize frontend workspace action enablement and display mapping
  so sidebar, detail, and admin panes use the same lifecycle semantics.
- [x] 3.3 Align iframe runtime-target mounting and reconnect behavior with the
  canonical readiness signal.

## 4. Structured Logging And Timing

- [x] 4.1 Add a Polaris-local structured logging helper for workspace
  lifecycle, refresh, and runtime-target events.
- [x] 4.2 Emit phase timing logs for slow workspace operations without
  persisting timing diagnostics into `status.json`.
- [x] 4.3 Add explicit logs for executor disconnect, timeout, and refresh
  reconciliation failures.

## 5. Regression Coverage And Docs

- [x] 5.1 Add regression tests for start, stop, rebuild, archive, and delete
  state transitions.
- [x] 5.2 Add regression tests for cross-user and cross-workspace state
  isolation in portal and admin views.
- [x] 5.3 Update Polaris docs to describe the canonical state contract and the
  new logging/debugging model.
