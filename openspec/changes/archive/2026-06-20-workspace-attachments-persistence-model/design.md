## Context

The current TypeScript control plane already models workspaces as first-class orchestration objects, but its persistence model is still too path-centric. The `WorkspaceSpec` shape still centers persistence around a single storage block and a list of durable paths, while the runtime contract still carries too much of the overall persistence meaning. That is not the right abstraction for a platform that must support multiple backends and distinguish workspace-scoped durable state from user-scoped durable state.

The problem is no longer “where should `/root` be mounted.” The real problem is that different state classes have different scopes and lifecycle semantics:

- `codex` and `claude` are user identity state and must be reusable across workspaces.
- SSH private data is user-scoped, cross-workspace state with stricter security semantics.
- `paseo` is workspace-scoped durable runtime state.
- project/worktree data is workspace-scoped durable data.
- pid files, sockets, and temp state remain ephemeral runtime artifacts.

The design must therefore stop treating persistence as “persist the runtime home” and instead treat it as “attach durable state classes and assemble runtime paths from them.”

## Goals / Non-Goals

**Goals:**

- Replace path-centric persistence semantics with attachment classes that explicitly encode scope, sharing, and durability.
- Separate workspace-scoped durable attachments from user-scoped durable attachments.
- Narrow the runtime contract so it governs ephemeral cleanup and minimal runtime invariants, rather than carrying the full persistence model.
- Define a backend-independent storage contract that pod, kubevirt-vm, and docker backends can implement with different physical mounts while exposing the same attachment semantics.
- Keep runtime home as an assembly point rather than the persistence boundary.

**Non-Goals:**

- Redesigning the agent harness itself.
- Defining the exact secret-management or identity-rotation implementation in this change.
- Collapsing user identity state and SSH state into one generic attachment class.
- Removing backend-specific mount implementation differences entirely.
- Deciding every sub-file inside `paseo` storage immediately; the important boundary is that `paseo` is workspace-scoped durable state while pid/socket/temp artifacts are not.

## Decisions

### Decision: Persistence is attachment-based, not home-based

The control plane will model durable state as attachment classes rather than as a persistent runtime home or a list of durable paths rooted in home. Runtime paths such as `/root/.codex` or `/root/.ssh` become assembled views of attached state, not the persistence contract itself.

Rationale:

- This removes accidental coupling between durable semantics and final runtime paths.
- It allows the same state classes to be mounted differently on pod, kubevirt-vm, and docker backends while preserving the same meaning.

Alternatives considered:

- Keep home-centered persistence and document path semantics more clearly. Rejected because it still conflates scope, lifecycle, and mount path.

### Decision: Use four durable attachment classes plus one ephemeral runtime class

The design uses the following state model:

- `workspace-data`
- `workspace-runtime-state`
- `user-identity-state`
- `user-ssh-state`
- `ephemeral-runtime`

The first four are explicit attachment classes. `ephemeral-runtime` is not durable and is governed by runtime cleanup semantics instead.

Rationale:

- These classes reflect the actual operational semantics already identified by the user.
- They define scope and lifecycle cleanly enough to support all current backends.

Alternatives considered:

- Merge `user-identity-state` and `user-ssh-state`. Rejected because SSH has stricter security and permission semantics.
- Treat `paseo` as user-global state. Rejected because `paseo` is workspace-scoped.

### Decision: User identity state and SSH state are cross-workspace user attachments

`codex` and `claude` state belong to `user-identity-state`, while SSH material belongs to `user-ssh-state`. Both are durable, user-scoped, and reusable across multiple workspaces.

Rationale:

- This matches the desired sharing model.
- It prevents workspace deletion from destroying user-global identity state.

Alternatives considered:

- Store identity state inside each workspace. Rejected because it breaks cross-workspace reuse and inflates workspace-local persistence.

### Decision: `paseo` is workspace runtime state, not user identity state

`paseo` belongs to `workspace-runtime-state`. It persists across restart/rebuild of the same workspace but is not shared across different workspaces. Ephemeral `paseo` runtime artifacts such as pid files and sockets remain part of `ephemeral-runtime`.

Rationale:

- This matches the workspace-local continuity requirement.
- It keeps persistent `paseo` state separate from transient daemon leftovers.

Alternatives considered:

- Treat the whole `.paseo` tree as uniformly durable. Rejected because runtime leftovers should remain stale-artifact cleanup targets.

### Decision: Runtime contract is reduced to minimal runtime invariants and ephemeral cleanup rules

The runtime contract will continue to define minimal invariants such as strict key permissions, readiness signals, and stale-artifact cleanup rules, but it will no longer be the place where overall persistence semantics are defined.

Rationale:

- Persistence semantics belong to attachment modeling, not runtime hygiene.
- This keeps the runtime contract focused and testable.

Alternatives considered:

- Leave persistence semantics split between storage config and runtime contract. Rejected because it preserves the current ambiguity.

### Decision: Backend drivers implement attachment semantics, not path semantics

Each backend driver will map the same attachment classes onto its own implementation primitives:

- pod: PVCs, projected volumes, secrets, `emptyDir`
- kubevirt-vm: virtiofs, disks, mounted secrets, local runtime paths
- docker: bind mounts, named volumes, tmpfs, legacy bridges where necessary

Rationale:

- This preserves backend flexibility without changing persistence meaning.
- It makes cross-backend behavior comparable and testable.

Alternatives considered:

- Encode one canonical physical mount plan and force all backends to mimic it. Rejected because it overfits implementation rather than semantics.

## Risks / Trade-offs

- [Attachment modeling introduces more explicit state categories] → Mitigation: make the attachment classes first-class and keep them small, stable, and clearly scoped.
- [Existing configs still express persistence in path-centric terms] → Mitigation: add a translation layer from legacy path-oriented config into explicit attachment classes before changing saved config formats.
- [Backend implementations may drift in how they realize shared user attachments] → Mitigation: specify scope, sharing, and lifecycle behavior at the spec level and validate them through backend driver tests.
- [Operators may still reason in terms of `/root`] → Mitigation: document runtime home as an assembly point rather than the persistence boundary.
- [`paseo` may still contain mixed durable and ephemeral sub-state] → Mitigation: keep the top-level class workspace-scoped now and explicitly classify stale pid/socket/temp artifacts as ephemeral cleanup targets.

## Migration Plan

1. Extend the TypeScript workspace model to express attachment classes explicitly.
2. Add a translation layer from current path-centric persistence fields into the new attachment model.
3. Update backend drivers to realize attachment classes rather than durable home paths.
4. Keep runtime path assembly stable for operators initially, even while the underlying persistence semantics change.
5. Refactor the runtime contract to retain only minimal invariants and ephemeral cleanup semantics.
6. Update docs so persistence is described in terms of attachment classes and lifecycle scopes.
7. Later, once stable, simplify saved workspace config formats to express attachment classes directly rather than via legacy path-oriented fields.

## Open Questions

- Should `user-identity-state` and `user-ssh-state` always be separate physical mounts, or only separate semantic classes?
- Should `workspace-runtime-state` and `workspace-data` be separate attachments by default, or can a backend co-locate them while preserving semantic distinction?
- What is the cleanest direct config shape for attachment classes once the legacy translation layer is removed?
- Which pieces of `paseo` state need explicit sub-classification beyond the top-level workspace-runtime-state versus ephemeral-runtime split?
