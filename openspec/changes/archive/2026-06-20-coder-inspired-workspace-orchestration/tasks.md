## 1. TypeScript CLI Foundation

- [x] 1.1 Add the TypeScript toolchain and runtime entrypoint for `scripts/agentctl.ts`
- [x] 1.2 Create the `scripts/agentctl/` module layout for `cli`, `core`, `config`, `backends`, `output`, and `utils`
- [x] 1.3 Introduce a temporary migration shim or hand-off path so operators can transition from Python to the TypeScript entrypoint safely
- [x] 1.4 Update repo-level documentation and operator conventions so the TypeScript CLI becomes the source of truth

## 2. Workspace Model And Config Reorganization

- [x] 2.1 Define a normalized workspace data model in TypeScript that separates identity, backend, storage, runtime, connectivity, lifecycle, and health intent from generated backend manifests
- [x] 2.2 Implement config loading, normalization, and validation for the TypeScript control plane
- [x] 2.3 Reorganize config inputs into `config/specs/base`, `config/specs/pod`, `config/specs/kubevirt`, and `config/specs/docker`
- [x] 2.4 Reorganize generated outputs into `config/generated/pod`, `config/generated/kubevirt`, and `config/generated/docker`

## 3. Backend Drivers

- [x] 3.1 Implement the backend driver interface in TypeScript for planning, rendering, inspection, health reporting, and reconcile behavior
- [x] 3.2 Implement the pod backend driver with pod profiles for `gvisor` and `kata`
- [x] 3.3 Implement the kubevirt backend driver while preserving current saved workspace semantics
- [x] 3.4 Introduce the docker backend driver and preserve existing docker-specific material under a `legacy/` boundary without rewriting it

## 4. Runtime Contract, Lifecycle, And Verification

- [x] 4.1 Encode durable state, stale runtime artifacts, and structural invariants into the TypeScript runtime contract
- [x] 4.2 Implement workspace lifecycle actions for create, start, stop, restart, rebuild, status, and reconcile
- [x] 4.3 Add structured workspace status and health reporting that distinguishes backend liveness, runtime readiness, daemon readiness, and degraded reasons
- [x] 4.4 Add or migrate tests for the TypeScript control plane and validate the supported backend flows with the new entrypoint
