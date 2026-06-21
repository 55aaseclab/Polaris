# Runtime Layout

## Backend Model

- `pod`
  - profiles: `gvisor`, `kata-qemu`, `kata-clh`, `kata-qemu-tdx`
- `kubevirt-vm`
- `docker`
  - clean default onboarding path
  - first-class backend target for spec -> render -> runtime flow

## Attachment Model

Durable state is modeled as attachment classes, not as a persisted runtime home:

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

## Current Reality

- New onboarding should start from `config/specs/docker/projects/*.agent.yaml`
  and `config/generated/docker/*.yaml`.
- New TypeScript code prefers `config/specs/**` and `config/generated/**`.
- Repo-managed specs now declare attachment classes directly.
- The control plane translates legacy path-centric persistence fields only as a
  compatibility path when direct attachment declarations are absent.
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
