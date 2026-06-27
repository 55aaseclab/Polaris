## Context

Polaris currently conflates three separate concerns:

- Paseo daemon lifecycle and pairing
- Installed harness tooling inside the workspace runtime
- User credential selection and provider switching

That coupling appears in both code and UX. The current credential bind or
unbind flow edits workspace credential bindings and also rewrites `agent.kind`
and `agent.persist_state`, even though daemon startup and harness installation
are already infrastructure behavior. The result is a misleading model where a
credential looks like the switch that turns the agent system on or off.

User credential lifecycle is also split across multiple paths. `user create`
directly scaffolds SSH registry and key material, while default Codex
credentials are created later during workspace scaffolding. That breaks the
ownership model for user credentials and makes provider switching harder to
reason about.

The current implementation already has useful building blocks:

- user-scoped credential registries under `config/users/<user>/credentials`
- user-scoped identity and SSH attachment surfaces
- runtime assembly that maps credential files into harness-specific paths
- workspace tooling bootstrap that installs CLIs into persistent tooling state

This change reorganizes those pieces into a cleaner model without introducing a
database or changing the file-based control plane.

## Goals / Non-Goals

**Goals:**

- Separate daemon lifecycle, harness availability, and credential selection.
- Make `user create` provision only the credentials required by the user
  profile.
- Move SSH key generation and SSH material creation into the credential
  creation path.
- Remove implicit default Codex credential creation from workspace scaffold.
- Introduce a shared credential service used by CLI, portal, and user
  lifecycle flows.
- Add a harness tool catalog that includes `codex`, `claude`, `copilot`,
  `opencode`, and `pi`.
- Add user-facing credential add, delete, list, and activate flows.
- Support the first provider template for Codex as RightCode.

**Non-Goals:**

- Installing `omp` in this phase.
- Embedding the full `cc-switch` application inside Polaris.
- Designing a full provider marketplace or template gallery in this phase.
- Finalizing workspace-level credential override behavior beyond a bounded
  compatibility path.

## Decisions

### Decision: Paseo daemon lifecycle is infrastructure, not credential state

Paseo daemon startup, pairing, and readiness SHALL remain part of workspace
infrastructure behavior. Credential selection SHALL NOT be treated as the
control that enables or disables daemon infrastructure.

Rationale:

- The daemon is already started from runtime bootstrap and inspected as a
  workspace concern.
- Harness CLIs are installed independently from credential selection.
- This produces a more honest mental model for both operators and users.

Alternatives considered:

- Keep using credential bind or unbind as an agent enable switch.
  Rejected because it preserves the misleading current coupling.

### Decision: Harness availability SHALL come from a shared tool catalog

Polaris SHALL define a shared harness and tool catalog for workspace bootstrap.
The first catalog entries SHALL include `paseo`, `codex`, `claude`, `copilot`,
`opencode`, and `pi`.

Rationale:

- Tool installation is currently hard-coded and duplicated around runtime
  bootstrap behavior.
- A catalog makes it easier to add harnesses consistently across backends.
- The catalog can later grow installer kinds beyond npm without redesigning the
  model again.

Alternatives considered:

- Keep adding package names directly to each renderer.
  Rejected because it increases duplication and hides the harness contract.

### Decision: User profile required credentials drive user provisioning

`user create` SHALL provision only the credentials required by the user
profile. In the current profile model, that means SSH only. The user profile
remains the source of truth for required credential classes, while credential
records remain first-class user-owned entities.

Rationale:

- It keeps required credential scaffolding explicit.
- It avoids silently creating provider-specific Codex credentials for users who
  have not chosen a provider.
- It aligns user lifecycle with the credential entity model.

Alternatives considered:

- Keep creating default Codex credentials during workspace scaffold.
  Rejected because workspace creation is the wrong ownership boundary.

### Decision: SSH generation moves into credential creation

The SSH credential creation path SHALL own key generation, registry creation,
and material file layout. `user create` will request the required SSH
credential through the shared credential service instead of scaffolding key
material directly.

Rationale:

- It removes special-case user scaffolding logic.
- It gives one implementation path for add, delete, and recreate.
- It makes delete behavior symmetrical with create behavior.

Alternatives considered:

- Keep SSH generation in `user create` and let only non-SSH credentials use the
  credential service.
  Rejected because it preserves two lifecycle models.

### Decision: Codex provider switching is user-level first

The first provider switching model SHALL be user-level, not workspace-level.
Users may own multiple Codex credentials, but one Codex credential is active at
a time for the user. Runtime assembly SHALL mount that active credential into
standard Codex paths unless a future workspace override is explicitly added.

Rationale:

- It matches the current user ask for adding, deleting, and switching Codex
  providers.
- It avoids carrying forward the current workspace bind or unbind UX as the
  primary model.
- It is closer to `cc-switch`'s provider activation concept without importing
  its application architecture.

Alternatives considered:

- Keep workspace-level bind or unbind as the only selection model.
  Rejected because it adds friction for a provider switch use case.

### Decision: `cc-switch` is reference material, not an embedded app

Polaris SHALL borrow ideas from `cc-switch`, especially provider templates and
active-provider semantics, but SHALL NOT embed the `cc-switch` app itself in
this phase.

Rationale:

- `cc-switch` has its own desktop shell, local database, and provider
  management runtime.
- Polaris already has a file-based control plane and existing UI shell.
- Reusing the ideas is lower risk than embedding or patching a second full app.

Alternatives considered:

- Vendor `cc-switch` as `apps/cc-switch` and patch it into Polaris.
  Rejected because it adds a second product architecture before the core model
  is stable.

### Decision: Workspace credential bind or unbind becomes a compatibility path

Existing workspace credential bind or unbind behavior SHALL be treated as a
compatibility path. It may continue to edit workspace credential references,
but it SHALL NOT be the primary UX for selecting a Codex provider and SHALL NOT
toggle daemon or harness infrastructure.

Rationale:

- The current routes exist and may still be useful for future workspace
  overrides.
- Keeping a bounded compatibility path reduces migration shock.
- Removing infrastructure toggling is the critical first fix.

Alternatives considered:

- Remove workspace bind or unbind routes immediately.
  Rejected because it may break current callers before a replacement lands.

## Risks / Trade-offs

- [User-level active credentials may not satisfy future workspace-specific
  overrides] → Keep workspace binding as a compatibility path and revisit
  override requirements after the user-level model lands.
- [Tool catalog expansion may reveal installer differences across CLIs] →
  Start with npm-compatible tools only in this phase.
- [Removing implicit default Codex creation may expose assumptions in tests and
  old flows] → Add migration-safe defaults in UI and tighten tests around
  explicit credential creation.
- [SSH creation through the credential service may affect existing user-create
  behavior] → Preserve existing generated paths and registry shape for the SSH
  credential in the first migration.

## Migration Plan

1. Introduce the shared credential service behind current CLI behavior.
2. Move SSH credential creation under that service while preserving current SSH
   artifact paths.
3. Update `user create` and `user delete` to call the shared credential
   service.
4. Remove implicit Codex credential creation from workspace scaffold.
5. Add user-level credential activation and update runtime assembly to consume
   the active Codex credential.
6. Update UI flows from bind or unbind semantics toward add, delete, and switch
   semantics.
7. Keep workspace bind or unbind routes as compatibility behavior, but remove
   any agent enable or disable side effects.
8. Update docs and tests to reflect the new model.

Rollback strategy:

- If needed, the compatibility bind or unbind path can continue serving old
  callers while the UI remains on the new user-level credential activation
  flow.
- SSH registry and material paths remain stable in the first phase, which keeps
  rollback low-risk for existing users.

## Open Questions

- Should future workspace-specific credential overrides apply to Codex only, or
  to all harnesses that support user-owned credentials?
- Should the active credential selection live in the user profile, a separate
  user settings document, or the credential registry itself?
- Should RightCode remain a hard-coded first template only, or should provider
  templates become declarative as part of this same change?
