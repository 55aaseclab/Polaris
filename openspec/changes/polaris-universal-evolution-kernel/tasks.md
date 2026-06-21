## 1. Generalize the workspace agent contract

- [x] 1.1 Replace the Paseo-specific `WorkspaceAgentContract.manager` model with a manager-generic contract shape in `scripts/polaris/core/workspace.ts`
- [x] 1.2 Extend workspace config loading in `scripts/polaris/config/load.ts` so saved specs resolve manager identity, capability flags, and evolution-related runtime paths
- [x] 1.3 Update `scripts/polaris/core/capabilities.ts` validation so manager-enabled workspaces are checked against contract capabilities instead of hard-coded Paseo-only assumptions

## 2. Make runtime state and readiness manager-agnostic

- [x] 2.1 Refactor `scripts/polaris/core/runtime-controller.ts` drift and status synthesis to represent manager-generic runtime assembly and readiness checks
- [x] 2.2 Update backend observation and reconcile types in `scripts/polaris/backends/types.ts` and related driver outputs to report manager/evolution surfaces rather than only `paseo`
- [x] 2.3 Update backend renderers and drivers under `scripts/polaris/backends/**` so they realize the generalized runtime contract while keeping Paseo as the first concrete manager adapter

## 3. Introduce the evolution kernel store and contracts

- [x] 3.1 Add a Polaris evolution module tree (for example `scripts/polaris/evolution/**`) with normalized event, artifact, retrieval, and curation types
- [x] 3.2 Implement a workspace-scoped evolution store under durable runtime state, including SQLite-backed persistence for execution records and structured learning artifacts
- [x] 3.3 Define the initial `AgentManagerAdapter` contract and implement the first adapter for Paseo-backed workspaces

## 4. Add reviewer, retrieval, and curation flows

- [x] 4.1 Implement asynchronous reviewer logic that transforms normalized execution history into typed artifacts such as user preferences, workspace playbooks, and verified lessons
- [x] 4.2 Implement retrieval logic that injects relevant workspace-local and user-linked learning artifacts into future manager runs
- [x] 4.3 Implement curator logic for deduplication, merge, archival, and confidence decay of evolution artifacts without deleting durable runtime history

## 5. Align documentation, fixtures, and tests

- [x] 5.1 Update Polaris docs such as `docs/polaris/README.md` and `docs/polaris/runtime-layout.md` to describe the manager-generic evolution model and runtime-state layout
- [x] 5.2 Update repo-managed specs and user-profile fixtures under `config/specs/**` and `config/users/**` so they reflect the generalized manager/evolution contract
- [x] 5.3 Add or update tests in `tests/polaris-cli.test.ts`, `tests/polaris-e2e.test.ts`, and any new evolution-focused test modules to cover contract loading, readiness/drift behavior, and evolution artifact persistence
