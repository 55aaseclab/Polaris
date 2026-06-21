## Why

Polaris now has the right internal persistence model, but users still configure an older path-centric view and rely on a translation layer to reach the new attachment semantics. That mismatch makes the control plane harder to reason about, keeps backend behavior tied to legacy assumptions, and prevents the attachment model from becoming the real platform contract.

## What Changes

- Make attachment classes the first-class user-facing config model.
- Define explicit config schema for:
  - `workspace-data`
  - `workspace-runtime-state`
  - `user-identity-state`
  - `user-ssh-state`
  - `ephemeral-runtime`
- **BREAKING** Deprecate path-centric persistence fields as the primary user-facing way to describe durable state.
- Keep a bounded compatibility story only as a migration bridge where required, rather than as the long-term config surface.
- Update backend realization to consume the first-class attachment schema directly instead of relying on legacy translation as the main path.
- Update docs and validation so the declared config model matches the internal platform model.

## Capabilities

### New Capabilities
- `attachment-config-schema`: First-class config schema for durable and ephemeral attachment classes.

### Modified Capabilities
- `workspace-attachments`: Attachment classes become the direct user-facing config model instead of only an internal representation.
- `workspace-attachment-lifecycle`: Attachment lifecycle rules become directly configurable and validated at config-load time.
- `workspace-orchestration`: Workspace intent is declared through attachment config instead of legacy path-centric persistence fields.

## Impact

- Primary impact on the TypeScript control plane under `scripts/agentctl/**`, especially config loading, validation, workspace modeling, and backend driver inputs.
- Spec/config impact on `config/specs/**`, because saved workspace intent must adopt the attachment schema directly.
- Backend impact on pod, kubevirt-vm, and docker flows, because they will consume first-class attachment declarations instead of translated legacy storage fields.
- Documentation impact on `docs/agentctl/README.md`, `docs/agentctl/runtime-layout.md`, and related operational references.
