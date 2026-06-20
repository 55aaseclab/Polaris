## Why

`geek-env` already has the beginnings of a multi-backend workspace system, but the current flow is still centered on rendering and applying backend manifests rather than managing a first-class workspace object. As more backends and runtime invariants accumulate, the lack of a unified orchestration model makes lifecycle operations, validation, and runtime recovery increasingly ad hoc. The current Python entrypoint also no longer matches the desired long-term control-plane direction: the unified entrypoint should move to TypeScript so the orchestration layer can be structured as a modular CLI rather than continue growing inside a single Python script.

## What Changes

- Replace `scripts/agentctl.py` as the source of truth with a TypeScript entrypoint rooted at `scripts/agentctl.ts`.
- Introduce a first-class workspace orchestration model in the TypeScript control plane that separates workspace intent, backend planning, backend realization, and runtime reconciliation.
- Define a normalized workspace spec contract that is backend-agnostic at the top level and allows backend-specific overlays and inputs.
- Formalize backend drivers so pod, kubevirt-vm, and docker paths implement a common orchestration interface instead of relying on scattered branching logic.
- Add an explicit lifecycle model for workspaces, including create, start, stop, restart, rebuild, status, and reconcile semantics.
- Define a runtime contract that distinguishes durable workspace state from stale runtime artifacts and structural invariants, so runtime cleanup remains safe and deterministic.
- Add structured workspace status and health reporting so daemon readiness, runtime reachability, and backend-specific failures can be diagnosed as workspace state rather than one-off troubleshooting.
- Reorganize configuration and generated output layout around backend kinds and pod profiles, while preserving old docker runtime content as packaged legacy material rather than rewriting it immediately.

## Capabilities

### New Capabilities
- `workspace-orchestration`: First-class workspace object model, lifecycle semantics, backend planning, and driver-based realization for the TypeScript `agentctl` control plane.
- `workspace-runtime-contract`: Deterministic runtime invariants, durable-state preservation rules, stale-artifact reconciliation, and health/status reporting for managed workspaces.
- `agentctl-typescript-cli`: TypeScript CLI entrypoint, module layout, and migration away from Python as the unified source of truth.

### Modified Capabilities
- None.

## Impact

- Primary code impact in new TypeScript sources under `scripts/agentctl.ts` and supporting `scripts/agentctl/**` modules.
- Spec and configuration impact in a reorganized `config/specs/**` and `config/generated/**` layout.
- Validation and user-story tests need expansion, especially around lifecycle actions, backend capability checks, and runtime reconciliation rules.
- Operational impact on pod, kubevirt-vm, and docker workspace management paths, including status reporting and repair logic.
- Migration impact on repo conventions, documentation, and test execution because Python is no longer the orchestration source of truth.
