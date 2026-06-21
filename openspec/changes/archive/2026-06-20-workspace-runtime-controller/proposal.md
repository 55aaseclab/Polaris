## Why

Polaris now has a solid workspace model and a stronger attachment-based persistence contract, but it still lacks a mature live-runtime control loop. The control plane can render and apply backend resources, yet it does not consistently inspect live backend state, compute drift against the declared workspace model, or build a structured reconcile plan before acting.

## What Changes

- Introduce a workspace runtime controller that separates:
  - backend observation
  - drift computation
  - status synthesis
  - reconcile planning
  - backend action execution
- Add backend inspection as a first-class responsibility for `pod`, `kubevirt-vm`, and `docker`.
- Add structured live observations for attachments, runtime assembly, daemon state, and services.
- Add a control-plane drift model that compares declared workspace intent with observed backend state.
- Add a reconcile plan model so Polaris can describe and then execute recovery actions deliberately rather than treating reconcile as a thin status wrapper.
- Upgrade `status` so it reflects control-plane truth about workspace health instead of placeholder backend liveness values.

## Capabilities

### New Capabilities
- `workspace-runtime-controller`: Control-plane pipeline for observation, drift detection, status synthesis, reconcile planning, and backend action execution.
- `workspace-backend-observation`: Backend observation model for pod, kubevirt-vm, and docker backends.

### Modified Capabilities
- `workspace-orchestration`: Workspace lifecycle actions now depend on control-plane observation and reconcile planning rather than direct backend delegation alone.
- `workspace-runtime-contract`: Runtime invariants and stale-artifact cleanup become inputs to drift detection and reconcile planning instead of only static validation concerns.

## Impact

- Primary impact on `scripts/polaris/**`, especially backend drivers, status/reconcile commands, workspace types, and output/state handling.
- Backend implementation impact on pod first, then kubevirt-vm and docker parity.
- Documentation impact on `docs/polaris/README.md` and `docs/polaris/runtime-layout.md`.
- Test impact across status, reconcile, drift detection, and backend-specific inspection behavior.
