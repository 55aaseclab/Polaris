## Context

Polaris now has a direct attachment-based config model, a clearer workspace object, and cleaner platform boundaries. But its live runtime control path is still immature. The control plane can render manifests and dispatch backend actions, yet it does not consistently observe live backend state, compute drift against declared workspace intent, or build reconcile plans before backend execution.

Today the runtime flow is effectively:

```text
WorkspaceSpec
  -> loadWorkspace()
  -> getBackendDriver()
  -> driver.status() / driver.reconcile()
```

That keeps too much judgment either unimplemented or backend-local. The result is shallow status, uneven backend behavior, and reconcile semantics that are more symbolic than operational.

## Goals / Non-Goals

**Goals:**

- Introduce a control-plane runtime controller pipeline:
  - backend inspection
  - observation modeling
  - drift computation
  - status synthesis
  - reconcile planning
  - backend execution
- Define a shared control-plane model for live workspace truth rather than letting each backend invent its own semantics.
- Make pod inspection the first serious implementation target, with KubeVirt and docker following the same conceptual model.
- Upgrade `status` and `reconcile` from thin backend calls into control-plane judgments and plans.

**Non-Goals:**

- Building a built-in agent platform or agent harness.
- Redesigning attachment classes again; this change consumes the attachment model rather than redefining it.
- Delivering perfect backend parity immediately for pod, kubevirt-vm, and docker.
- Introducing a web UI or multi-user governance layer.

## Decisions

### Decision: Separate observation, drift, status, and reconcile planning

The control plane will explicitly separate:

- `BackendObservation`
- `WorkspaceDrift`
- `WorkspaceStatus`
- `ReconcilePlan`

Rationale:

- This avoids conflating raw backend evidence with control-plane judgment.
- It creates a reusable model across backends.

Alternatives considered:

- Put more logic directly into `driver.status()` and `driver.reconcile()`. Rejected because it keeps semantics fragmented across backends.

### Decision: Backend drivers produce observations, not final judgments

Each backend driver should inspect its live resources and return backend observations. The control plane should compute drift, synthesize user-facing status, and generate reconcile plans from those observations.

Rationale:

- This keeps backend drivers focused on evidence and execution.
- It centralizes workspace truth in one place.

Alternatives considered:

- Let each backend return fully interpreted health and reconcile decisions. Rejected because it prevents consistent cross-backend semantics.

### Decision: Reconcile becomes planful before execution

Reconcile will first build a `ReconcilePlan` and only then ask the backend to execute relevant actions.

Rationale:

- This makes reconcile safer, more observable, and easier to test.
- It allows the control plane to distinguish safe repairs from destructive or unsupported ones.

Alternatives considered:

- Continue treating reconcile as “backend decides what to do now.” Rejected because that is too opaque and hard to reason about.

### Decision: Pod backend goes first, KubeVirt and docker follow

The pod backend will be the first implementation target for rich inspection, drift detection, and reconcile planning. KubeVirt and docker will follow the same model with reduced initial fidelity where necessary.

Rationale:

- Pod is currently the most operationally important and most inspectable backend.
- This reduces implementation risk while proving the control-plane model.

Alternatives considered:

- Attempt equal fidelity for all backends immediately. Rejected because it spreads effort too thinly.

### Decision: Status becomes control-plane truth, not raw backend state

`WorkspaceStatus` should reflect the control plane’s interpretation of the workspace as a whole, including attachments, runtime assembly, daemon state, services, drift, and overall readiness.

Rationale:

- Backend existence alone is not workspace truth.
- This makes Polaris more platform-like and closer to Coder’s operational maturity.

Alternatives considered:

- Keep status as thin backend liveness plus a few details. Rejected because it is not operationally useful enough.

## Risks / Trade-offs

- [The new controller model introduces several new types] → Mitigation: keep the initial model small and centered on observation, drift, status, and reconcile plan only.
- [Pod backend may become significantly more complex before other backends catch up] → Mitigation: document pod-first sequencing explicitly and preserve shared interfaces from the start.
- [Status semantics may become over-engineered] → Mitigation: design them around real operational questions already present in Polaris rather than abstract telemetry.
- [Reconcile planning may surface unsupported drift that cannot yet be fixed] → Mitigation: make unsupported or unrecoverable drift an explicit plan outcome instead of hiding it.
- [Backend observation may require more shelling out and parsing] → Mitigation: isolate observation logic cleanly inside backends and keep judgment logic outside of them.

## Migration Plan

1. Introduce shared TypeScript types for backend observations, drift items, status details, and reconcile plans.
2. Add control-plane functions that compute drift and synthesize status from observations.
3. Implement pod backend inspection and wire `status` through the new controller path.
4. Implement reconcile planning for pod and make reconcile output reflect the plan.
5. Extend KubeVirt and docker backends to return observations, even if initial fidelity is lower.
6. Update docs and tests to describe and validate the controller model.
7. Later, deepen backend parity and expand supported reconcile actions.

## Open Questions

- What exact observation shape is minimal but sufficient for all current backends?
- How much of `WorkspaceStatus` should be persisted to `config/state/` versus computed on demand?
- Should reconcile plans be printed by default before execution, or only surfaced in verbose/debug modes?
- How should unsupported drift be represented so operators can act on it without mistaking it for successful reconciliation?
