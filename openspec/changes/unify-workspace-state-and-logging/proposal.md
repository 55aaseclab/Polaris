## Why

Workspace state is currently derived in too many places: executor actions,
backend observation, persisted status files, and portal display helpers all
contribute overlapping truth. That split has caused repeated regressions:
wrong labels, stale transitions, cross-workspace leakage, and hard-to-debug
latency when the portal keeps polling without clear phase visibility.

This change is needed now because the portal and admin UX are stabilizing, but
the underlying state and logging model is still inconsistent. We need one
canonical workspace state contract and one structured logging model before
making broader UX or naming changes.

## What Changes

- Define one canonical workspace lifecycle state model that covers persisted
  state, live backend evidence, in-flight actions, and portal display.
- Standardize how Polaris derives current workspace state from backend
  observations instead of letting each layer invent its own status merge.
- Remove ambiguous or duplicated state fields from the public workspace
  contract where they do not represent unique truth.
- Add structured operational logging for workspace lifecycle transitions,
  refreshes, iframe target readiness, and slow-path timing.
- Separate debug logging from durable state transitions so diagnostics can be
  enabled without mutating workspace data.
- Add regression coverage for stale transitions, action-state drift, and
  cross-user or cross-workspace status contamination.

## Capabilities

### New Capabilities

- `workspace-operational-logging`: Structured logging and timing requirements
  for workspace lifecycle, refresh, and portal/runtime readiness flows.

### Modified Capabilities

- `workspace-runtime-contract`: Replace overlapping runtime state semantics
  with one canonical workspace lifecycle contract and explicit readiness
  meaning.
- `workspace-backend-observation`: Tighten the boundary between raw backend
  evidence and control-plane state derivation so observations feed a single
  resolver.
- `workspace-portal`: Require the portal to render workspace state from the
  canonical contract and use structured readiness signals for iframe/runtime
  presentation.

## Impact

- Backend status derivation, executor lifecycle handlers, and persisted
  workspace status files.
- Portal workspace detail, admin workspace management, and sidebar status
  presentation.
- Timing and debug logs around refresh loops, daemon pairing readiness, and
  runtime target publication.
- Automated tests for lifecycle actions, state persistence, and portal display
  behavior.
