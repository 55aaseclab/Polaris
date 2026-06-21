## Why

Polaris has grown from a backend renderer into a workspace control plane with explicit workspace profiles, user profiles, attachment classes, runtime contracts, and reconcile logic. That makes it possible to add a reusable evolution layer at the Polaris boundary instead of binding learning, review, and recall directly to Paseo internals.

## What Changes

- Introduce a Polaris-native evolution kernel that records agent-manager execution history, derives structured lessons, and re-injects relevant context into future runs.
- Generalize the workspace agent contract so Polaris targets an abstract manager capability surface instead of hard-coding `paseo` as the only meaningful orchestration manager.
- Add a workspace-scoped evolution store under durable runtime state for transcripts, lessons, playbooks, evaluations, and curator state.
- Add a user-profile-linked preference and identity recall model so long-lived operator preferences can be separated from workspace-local operational knowledge.
- Add reviewer, retriever, and curator control-plane behaviors that operate on structured evolution artifacts rather than directly mutating external agent private state.
- **BREAKING**: `workspace-runtime-state`, runtime assembly checks, and daemon readiness semantics must stop assuming that durable manager state is specifically `paseo` state and instead model a manager-generic evolution/runtime contract.

## Capabilities

### New Capabilities
- `workspace-evolution-kernel`: A manager-agnostic learning layer for capturing agent execution history, producing structured lessons, and retrieving them for future workspace runs.

### Modified Capabilities
- `workspace-orchestration`: The workspace agent contract changes from a Paseo-specific manager model to a manager-agnostic contract with explicit capability negotiation.
- `workspace-runtime-contract`: Durable runtime state and readiness requirements change from explicit Paseo-only assumptions to a generic manager/evolution state model.
- `workspace-runtime-controller`: Observation, drift, and reconcile behavior change to evaluate manager-generic runtime assembly and evolution state instead of hard-coded Paseo checks.

## Impact

- Affected code:
  - `scripts/polaris/core/workspace.ts`
  - `scripts/polaris/core/capabilities.ts`
  - `scripts/polaris/core/runtime-controller.ts`
  - `scripts/polaris/config/load.ts`
  - `scripts/polaris/backends/**`
  - future `scripts/polaris/evolution/**` modules
- Affected docs:
  - `docs/polaris/README.md`
  - `docs/polaris/runtime-layout.md`
- Affected state model:
  - workspace runtime durable state
  - user-profile-linked preference recall
- External systems:
  - Paseo remains the first manager adapter, but the contract must allow future non-Paseo managers without rewriting the evolution layer
