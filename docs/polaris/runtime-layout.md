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
  pod/
    profiles/
  users/
    profiles/
    <user>/
      credentials/
      projects/
        <project>/
          *.agent.yaml
          generated/
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

- New onboarding should start from
  `config/users/<user>/projects/<project>/docker.agent.yaml`
  and `config/users/<user>/projects/<project>/generated/docker.yaml`.
- New TypeScript code prefers user-scoped saved specs and generated artifacts
  under `config/users/**`.
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

- saved intent lives under `config/users/<user>/projects/<project>/`
- rendered output lives under
  `config/users/<user>/projects/<project>/generated/`
- the rendered artifact is a Docker Compose file consumed by `docker compose`
- `status` also writes a synthesized control-plane view to
  `config/users/<user>/projects/<project>/state/`
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
