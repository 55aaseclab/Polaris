## 1. Shared Controller Model

- [x] 1.1 Define shared TypeScript types for `BackendObservation`, `WorkspaceDrift`, `WorkspaceStatus`, and `ReconcilePlan`
- [x] 1.2 Add control-plane logic that computes drift from a declared workspace spec plus backend observations
- [x] 1.3 Add control-plane logic that synthesizes workspace status from observations and drift
- [x] 1.4 Add control-plane logic that builds reconcile plans before backend execution

## 2. Pod Backend First

- [x] 2.1 Implement pod backend inspection that returns structured live observations
- [x] 2.2 Inspect pod attachment state, runtime path assembly, daemon evidence, and service exposure
- [x] 2.3 Wire `status` through pod observation plus control-plane status synthesis
- [x] 2.4 Wire `reconcile` through pod observation plus control-plane reconcile planning

## 3. Backend Parity And Execution

- [x] 3.1 Extend the KubeVirt backend to return structured observations at the fidelity it can support today
- [x] 3.2 Extend the docker backend to return structured legacy observations rather than only unsupported placeholders
- [x] 3.3 Add backend execution hooks for reconcile-plan actions that are safe and currently supported
- [x] 3.4 Represent unsupported or unrecoverable drift explicitly rather than hiding it behind generic status

## 4. Docs And Verification

- [x] 4.1 Update Polaris docs to explain the runtime-controller pipeline and status/reconcile behavior
- [x] 4.2 Add tests for drift computation and status synthesis from backend observations
- [x] 4.3 Add tests for reconcile-plan generation and backend-specific observation fidelity
- [x] 4.4 Validate the controller model through TypeScript typecheck, test suite, and representative `status`/`reconcile` flows
