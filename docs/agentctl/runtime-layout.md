# Runtime Layout

## Backend Model

- `pod`
  - profiles: `gvisor`, `kata-qemu`, `kata-clh`, `kata-qemu-tdx`
- `kubevirt-vm`
- `docker`
  - currently preserved as a legacy backend boundary during migration

## Attachment Model

Durable state is modeled as attachment classes, not as a persisted runtime home:

- `workspace-data`
  - workspace-scoped
  - not shared across workspaces
- `workspace-runtime-state`
  - workspace-scoped
  - not shared across workspaces
  - includes durable `paseo` state
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

## Current Reality

- New TypeScript code prefers `config/specs/**` and `config/generated/**`.
- Repo-managed specs now declare attachment classes directly.
- The control plane translates legacy path-centric persistence fields only as a
  compatibility path when direct attachment declarations are absent.
- Legacy saved configs still exist under:
  - `config/gvisor/specs/`
  - `config/kubevirt/specs/`
- Legacy generated manifests still exist under:
  - `config/gvisor/generated/`
  - `config/kubevirt/generated/`
- Backend implementations may still realize the same attachment classes with
  different physical mount primitives, but they are expected to preserve the
  same scope and lifecycle semantics.
