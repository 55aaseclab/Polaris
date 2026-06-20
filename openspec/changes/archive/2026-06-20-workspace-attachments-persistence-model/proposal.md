## Why

The current workspace persistence model is still too close to filesystem-path thinking: it treats persistence primarily as a mounted home or a list of durable paths. That is not stable enough for a multi-backend workspace platform, especially now that the system must distinguish workspace-scoped state from user-scoped state and support the same persistence semantics across pod, kubevirt-vm, and docker backends.

## What Changes

- Replace the current path-centric persistence model with explicit attachment classes.
- Define separate durable attachment categories for workspace-scoped data, workspace-scoped runtime state, user-scoped identity state, and user-scoped SSH state.
- Define ephemeral runtime state as a non-durable class with distinct lifecycle and cleanup semantics.
- **BREAKING** Reframe persistence semantics away from “persist the runtime home” toward “attach durable state classes and assemble runtime paths from them.”
- Define backend mapping expectations so pod, kubevirt-vm, and docker backends expose the same attachment semantics even when their physical mounts differ.
- Clarify how `paseo`, `codex`, `claude`, and SSH material map into those attachment classes.

## Capabilities

### New Capabilities
- `workspace-attachments`: Attachment-based persistence model for workspace-scoped and user-scoped durable state.
- `workspace-attachment-lifecycle`: Lifecycle, sharing, and cleanup rules for durable and ephemeral attachment classes across backends.

### Modified Capabilities
- `workspace-orchestration`: Workspace storage semantics change from path-centric persistence to attachment-class-based persistence.
- `workspace-runtime-contract`: Runtime contract is narrowed to minimal runtime invariants and ephemeral cleanup semantics instead of carrying the full persistence model.

## Impact

- Primary impact on the TypeScript control plane under `scripts/agentctl/**`, especially workspace modeling, config loading, backend drivers, and runtime assembly.
- Spec and config impact on `config/specs/**`, since saved workspace intent must express durable attachments explicitly.
- Backend impact on pod, kubevirt-vm, and docker implementations, because each backend must map the same attachment classes onto its own storage primitives.
- Documentation impact on `docs/runtime-layout.md`, `docs/agentctl.md`, and related operator-facing material.
