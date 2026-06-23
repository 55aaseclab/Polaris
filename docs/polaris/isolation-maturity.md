# Isolation Maturity

## Short Version

For `Isolation`, Polaris has the more explicit substrate model.
`Coder` has the more mature production operating model.

## Polaris Today

- Isolation is a core design concern.
- Polaris can target:
  - `pod`
  - `kubevirt-vm`
  - `docker`
- Pod and VM paths are treated as first-class runtime backends.
- The control plane reasons about runtime assembly and state inside those
  environments.

## Coder Today

Coder is mature on workspace provisioning and secure self-hosted environments,
but its product center of gravity is not "multi-backend isolation as a first
class abstraction" in the same explicit way Polaris models it.

Coder is stronger on:

- production deployment maturity
- admin controls
- enterprise governance
- broad infrastructure integration

## Gap

Polaris has the more explicit isolation substrate model.

Coder has the more mature production operational model.

## Polaris Strength

- Stronger conceptual split between workspace intent and backend realization
- Clearer runtime-state and attachment semantics across isolation surfaces
- Better foundation for saying "this workspace can move across pod/vm/docker
  while keeping the same logical contract"

## Backend Model

- `pod`
  - profiles: `gvisor`, `kata-qemu`, `kata-clh`, `kata-qemu-tdx`
- `kubevirt-vm`
- `docker`
  - clean default onboarding path
  - first-class backend target for spec -> render -> runtime flow

## Attachment Model

Durable state is modeled as attachment classes, not as a persisted runtime
home:

- `workspace-data`
  - workspace-scoped
  - not shared across workspaces
- `workspace-runtime-state`
  - workspace-scoped
  - not shared across workspaces
  - includes durable manager state
  - includes workspace evolution state
- `user-identity-state`
  - user-scoped
  - cross-workspace
  - includes `codex` and `claude`
- `user-ssh-state`
  - user-scoped
  - cross-workspace
  - includes SSH private/public material and related state

Non-durable runtime state is modeled separately:

- `ephemeral-runtime`
  - pid files
  - sockets
  - temp state
  - transient runtime leftovers

Runtime home paths are assembled views of these attachments rather than the
persistence boundary itself.

For the current Paseo-backed runtime, the default realization is:

- manager state: `/workspace/state/paseo`
- evolution state: `/workspace/state/paseo/evolution`

## Config Layout

Long-term target layout:

```text
config/
  specs/
    base/
    pod/
      profiles/
      projects/
    kubevirt/
      projects/
    docker/
      projects/
  generated/
    pod/
    kubevirt/
    docker/
  state/
```

Profiles are part of the workspace intent layer. A workspace may select a
built-in profile such as `morpheus`, and backend renderers consume profile
defaults rather than branching directly on the workspace name.

Polaris now distinguishes between:

- workspace profile: backend/runtime-oriented defaults
- user profile: Git identity, SSH policy, and ownership of user-scoped
  identity state
- user credential registry: reusable auth declarations and material references
- workspace credential bindings: per-workspace credential selection by purpose

Credential registry layout:

```text
config/users/profiles/<user>.yaml
config/users/<user>/credentials/*.yaml
```

Each credential declares stable metadata and `materialRef`.
Secret material stays outside the registry document.

Workspace config binds credentials separately from driver selection:

```yaml
backend:
  kind: docker
credentials:
  bindings:
    - purpose: agent-auth
      credentialId: codex-default
      required: true
```

## Current Reality

- New onboarding should start from `config/specs/docker/projects/*.agent.yaml`
  and `config/generated/docker/*.yaml`.
- New TypeScript code prefers `config/specs/**` and `config/generated/**`.
- Repo-managed specs now declare attachment classes directly.
- Repo-managed specs may also declare credential bindings directly.
- The control plane translates legacy path-centric persistence fields only as a
  compatibility path when direct attachment declarations are absent.
- The control plane also treats legacy inline auth fields as compatibility-only
  when direct credential bindings are present.
- Backend implementations may still realize the same attachment classes with
  different physical mount primitives, but they are expected to preserve the
  same scope and lifecycle semantics.
- Pod currently has the deepest runtime-controller support.
- KubeVirt and Docker are expected to converge on the same controller model.
- Morpheus remains a built-in profile/example, not a backend-special-case name.

For Docker specifically:

- saved intent lives under `config/specs/docker/projects/`
- rendered output lives under `config/generated/docker/`
- the rendered artifact is a Docker Compose file consumed by `docker compose`
- `status` also writes a synthesized control-plane view to `config/state/`
- when the same project name exists across multiple backends, operators can use
  `<project>@docker`, `<project>@pod`, or `<project>@kubevirt-vm` to select the
  intended saved spec
- user-scoped identity storage is expected to derive from explicit user profile
  identity rather than only from runtime UNIX user

## Runtime Controller Pipeline

Polaris is moving toward a runtime-controller model:

```text
WorkspaceSpec
  -> BackendObservation
  -> WorkspaceDrift
  -> WorkspaceStatus
  -> ReconcilePlan
  -> Backend action execution
```

This makes live workspace truth a control-plane concern rather than a thin
backend-local status response.

## TODO Toward Coder Maturity

- Make backend parity boring:
  same lifecycle quality, same diagnostics, same docs, same recovery behavior.
- Add stronger backend capability matrices and preflight validation.
- Add operational SLO-level observability for backend provisioning and runtime
  failures.
- Add safer rollback and repair flows for backend-specific failures.
- Add platform install stories that are simpler than reading repo internals.
