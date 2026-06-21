## 1. Attachment Model

- [x] 1.1 Extend the TypeScript workspace model to represent `workspace-data`, `workspace-runtime-state`, `user-identity-state`, and `user-ssh-state` as explicit durable attachment classes
- [x] 1.2 Add `ephemeral-runtime` as an explicit non-durable runtime state category in the control-plane model
- [x] 1.3 Add a legacy translation layer that maps current path-centric persistence fields into the new attachment classes
- [x] 1.4 Update validation so attachment scope, sharing, and durability rules are enforced before backend realization

## 2. Backend Realization

- [x] 2.1 Update the pod backend driver to realize attachment classes rather than a durable runtime home
- [x] 2.2 Update the kubevirt-vm backend driver to realize the same attachment semantics with backend-specific mount primitives
- [x] 2.3 Update the docker backend boundary so it exposes the same attachment semantics even while remaining legacy-backed
- [x] 2.4 Ensure runtime path assembly presents attached state under the expected runtime-visible locations without making those paths the persistence contract

## 3. Runtime Contract Narrowing

- [x] 3.1 Refactor the runtime contract to retain only minimal runtime invariants and stale-artifact cleanup rules
- [x] 3.2 Classify `paseo` durable state under `workspace-runtime-state` while keeping pid/socket/temp artifacts under `ephemeral-runtime`
- [x] 3.3 Classify `codex` and `claude` under `user-identity-state`
- [x] 3.4 Classify SSH private data under `user-ssh-state` and enforce its stricter runtime permission invariants

## 4. Docs And Verification

- [x] 4.1 Update `docs/runtime-layout.md` and related docs to describe persistence in terms of attachment classes rather than persisted home paths
- [x] 4.2 Add or update tests for attachment translation, backend mapping, and runtime path assembly semantics
- [x] 4.3 Add or update tests for attachment lifecycle behavior across workspace restart, rebuild, and delete boundaries
- [x] 4.4 Validate the new attachment model through TypeScript typecheck, agentctl tests, and representative backend render/status flows
