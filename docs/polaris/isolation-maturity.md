# Isolation Maturity

This document describes the current Polaris isolation model as a workspace
control-plane boundary.

## Purpose

Polaris owns workspace intent, attachment semantics, runtime assembly checks,
and drift/reconcile logic rather than treating isolation as a thin backend
rendering detail.

## Scope And Files

Polaris now keeps saved workspace intent, generated backend artifacts,
operator state, and runtime attachments separate.

| Concern | Contents | Control-plane source of truth | Runtime / user-facing realization |
|---|---|---|---|
| Saved workspace intent | Project, backend, attachments, user profile, credentials, service settings | `config/users/<user>/workspaces/<project>/<backend>.agent.yaml` | none |
| User profile | User identity, Git identity, SSH policy, agent identity defaults, owned workspace list | `config/users/profiles/<user>.yaml` | selected by `user_profile` in workspace specs |
| Credential registry | User-owned reusable auth declarations and material references | `config/users/<user>/credentials/*.yaml` | resolved into identity or SSH attachments |
| Generated backend artifact | Rendered manifest consumed by the backend runtime | `config/users/<user>/workspaces/<project>/generated/<backend>.yaml` | `docker compose`, `kubectl apply`, or `kubectl` + KubeVirt objects |
| Driver selection state | Preferred backend and optional pod profile for ambiguous project names | `config/users/<user>/workspaces/<project>/state/selection.json` | CLI default resolution for `<project>` |
| Status snapshot | Synthesized backend, attachment, runtime-assembly, daemon, SSH, and drift status | `config/users/<user>/workspaces/<project>/state/status.json` | `polaris status <project>` output |
| Workspace data attachment | Project files and workspace-local durable content | Saved spec `attachments.workspace-data` | mounted at `/workspace/project` |
| Workspace runtime-state attachment | Durable manager state, pairing state, and evolution state | Saved spec `attachments.workspace-runtime-state` | mounted at `/workspace/state` |
| User identity attachment | Cross-workspace Codex and Claude identity state | Saved spec `attachments.user-identity-state` | mounted at `/identity`, assembled into `~/.codex` and `~/.claude` |
| User SSH attachment | Cross-workspace SSH key material | Saved spec `attachments.user-ssh-state` | mounted at `/ssh`, assembled into `~/.ssh` |
| Ephemeral runtime state | PID files, sockets, temp state, and stale runtime artifacts | Saved spec `attachments.ephemeral-runtime` or compatibility defaults | mounted at `/run/workspace` |

Current gaps versus a more mature platform:

- backend parity is incomplete
- KubeVirt inspection still depends on SSH and port-forward probing
- install and bootstrap flows are still operator-heavy
- backend capability matrices and preflight validation remain thin
- reconcile repair behavior is still coarse and restart-heavy

## Polaris vs Coder

| Capability | Polaris Today | Coder Today |
|---|---|---|
| Isolation abstraction | 1. Model workspace intent separately from backend realization. 2. Preserve one logical contract across `docker`, `pod`, and `kubevirt-vm`. 3. Treat attachment classes as the persistence boundary. | 1. Strong workspace provisioning product. 2. Mature secure environment operations. 3. Isolation is not exposed as the same explicit multi-backend substrate model. |
| Saved spec model | 1. Load per-user saved specs from `config/users/<user>/workspaces/<project>/`. 2. Normalize attachments, credentials, user profile, and runtime contract. 3. Validate the workspace object before backend use. | 1. Template- and deployment-centered product model. 2. Strong admin and governance controls. 3. Less emphasis on repo-visible attachment semantics. |
| Backend realization | 1. Dispatch through backend drivers for `docker`, `pod`, and `kubevirt-vm`. 2. Render generated artifacts per backend. 3. Start, stop, restart, render, apply, logs, inspect, and reconcile through the same CLI surface. | 1. More mature operational runtime stories. 2. Richer deployment and governance controls. 3. Less focus on backend switching inside one repo-native control plane. |
| Attachment semantics | 1. Keep workspace data and workspace runtime state exclusive to one workspace. 2. Keep identity and SSH state cross-workspace at user scope. 3. Assemble runtime home as symlinks and mounts instead of using home directories as the persistence boundary. | 1. Durable home/workspace behavior is operationally mature. 2. Product semantics are less explicitly exposed as attachment classes. |
| Runtime truth and drift | 1. Inspect live backend state. 2. Check attachment presence, runtime assembly, daemon readiness, and services. 3. Synthesize status and build a reconcile plan from drift. | 1. Stronger production operations and observability. 2. More mature platform-level health and governance. |
| Backend switching | 1. Allow `<project>@docker`, `<project>@pod`, and `<project>@kubevirt-vm`. 2. Persist default backend selection. 3. Synthesize missing backend specs from an existing source spec. | 1. Mature provisioning lifecycle. 2. Not centered on "same workspace, multiple isolation substrates" as a first-class repo-native operator flow. |

## Backend Surface

Polaris currently supports three backend kinds:

- `docker`
- `pod`
- `kubevirt-vm`

Pod-specific isolation variants are modeled as pod profiles, not top-level
backend kinds:

- `gvisor`
- `kata-qemu`
- `kata-clh`
- `kata-qemu-tdx`

The current code also supports profile aliases through saved driver selection
and profile specs, such as `kata` or `kata-container`, which resolve to a pod
backend profile during load or switch flows.

## Attachment Model

Durable state is modeled as attachment classes, not as a persisted runtime
home:

- `workspace-data`
  - scope: `workspace`
  - sharing: `exclusive`
  - default mount: `/workspace/project`
- `workspace-runtime-state`
  - scope: `workspace`
  - sharing: `exclusive`
  - default mount: `/workspace/state`
  - durable paths include `/workspace/state/paseo`
  - durable paths include `/workspace/state/paseo/evolution`
- `user-identity-state`
  - scope: `user`
  - sharing: `cross-workspace`
  - default mount: `/identity`
  - assembled into `~/.codex` and `~/.claude`
- `user-ssh-state`
  - scope: `user`
  - sharing: `cross-workspace`
  - default mount: `/ssh`
  - assembled into `~/.ssh`

Non-durable runtime state is modeled separately:

- `ephemeral-runtime`
  - default mount: `/run/workspace`
  - paths include temp files, PID files, and sockets
  - stale artifacts include `/run/workspace/pids/paseo.pid`

Runtime home paths are assembled views of these attachments rather than the
persistence boundary itself.

## User Management

Polaris now treats the user profile as a first-class control-plane object
rather than inferring durable identity only from the runtime UNIX user.

Current user-profile semantics:

- the workspace spec selects a user through `user_profile`
- the user profile lives in `config/users/profiles/<user>.yaml`
- the profile carries name, email, GitHub account, SSH mode, and agent
  identity defaults
- the profile may also list owned workspaces through `workspaces`
- scaffold flows update that workspace list when new workspaces are created

Current ownership boundaries:

- one workspace spec belongs to one user profile
- one user profile can own many workspaces
- one project name cannot currently be owned by multiple users at the same
  time
- Polaris rejects cross-user project-name collisions until user-qualified
  runtime naming exists

Compatibility still exists for older specs:

- if `user_profile` is absent, Polaris derives a compatibility user profile
  from runtime user and inline Git identity
- that path is explicitly a fallback, not the preferred long-term model

## Credential Model

Polaris now separates credential selection from backend selection.

Current credential semantics:

- credentials are user-owned registry objects
- the active registry root is `config/users/<user>/credentials/`
- a legacy fallback registry path still exists at
  `config/users/credentials/<user>/`
- each credential declares stable metadata, supported purposes, and a
  `materialRef`
- secret material must stay external to the registry entry and is referenced
  through `materialRef.files[].source_path`

Workspace specs bind credentials by purpose:

- `agent-auth`
- `git-auth`
- `ssh-auth`

Current resolution rules:

- if explicit `credentials.bindings` exist, Polaris resolves only those
  registry credentials
- the bound credential must be owned by the selected user profile
- the bound credential must declare support for the requested purpose
- registry-backed credentials override legacy inline auth for the same purpose
- if no direct bindings exist, Polaris derives compatibility credentials from
  inline auth material

Credential resolution also chooses the attachment boundary:

- `codex-auth` and similar non-SSH credentials resolve into
  `user-identity-state`
- `ssh-key` credentials resolve into `user-ssh-state`

This matters for isolation because Polaris treats credentials as control-plane
bindings onto attachment classes, not as backend-local mount hacks.

## Workspace Model

Polaris now treats the workspace as a first-class object that sits between user
ownership and backend realization.

Current workspace semantics:

- the workspace identity is the project name
- the workspace spec selects one backend kind and may select a pod profile
- the workspace spec binds one user profile and zero or more credentials
- the workspace spec declares attachment classes directly when using the newer
  model
- generated backend artifacts are derived from that workspace object

Current lifecycle and ownership implications:

- `user create` scaffolds the user profile and default credentials
- `create` creates a Docker-first saved spec for an existing user
- the same logical workspace can later be targeted as `@docker`, `@pod`, or
  `@kubevirt-vm`
- missing backend specs can be synthesized from an existing workspace spec
- backend preference can be persisted per workspace in `state/selection.json`
- status, drift, and reconcile operate on the normalized workspace object, not
  directly on hand-maintained manifests

The practical result is that user management, credential binding, and isolation
policy are now centered on the workspace object rather than split across ad hoc
backend-specific files.

## Current Reality

Polaris has moved beyond the older "future config/specs layout" document
direction. The code today actually does the following:

- loads saved specs from `config/users/<user>/workspaces/<project>/`
- writes generated backend artifacts under each project's `generated/`
  directory
- writes status and backend-selection state under each project's `state/`
  directory
- validates attachment semantics in the TypeScript control plane before backend
  execution
- supports direct attachment declarations in repo-managed specs
- keeps legacy path-centric persistence fields only as a compatibility path
- separates user profile identity from workspace profile defaults
- resolves credentials separately from backend selection
- rejects project ownership collisions across multiple users
- requires registry credentials to be owned by the selected user profile
- treats generated manifests as derived artifacts, not the primary source of
  truth

For backend realization today:

- `docker`
  - is the default onboarding path
  - renders a Docker Compose file
  - bootstraps runtime assembly inside the container
  - uses inspect checks based on `docker compose`, `docker inspect`, and
    `docker exec`
- `pod`
  - has the deepest Kubernetes-native controller flow
  - renders Deployment and related Kubernetes objects
  - inspects runtime state with `kubectl get` and `kubectl exec`
- `kubevirt-vm`
  - has a real backend driver and render/inspect flow
  - starts and stops through `kubectl virt` when available or VM patch fallback
  - still probes guest state through service reachability, port-forward, and
    SSH, which is less mature than the pod path

## Runtime Controller

Polaris now has an explicit runtime-controller pipeline:

```text
WorkspaceSpec
  -> BackendObservation
  -> WorkspaceDrift
  -> WorkspaceStatus
  -> ReconcilePlan
  -> Backend action execution
```

This means live isolation truth is no longer just "backend says it is up."
Polaris checks:

- backend existence and liveness
- attachment presence
- runtime assembly invariants
- daemon readiness and pairing
- service object presence
- SSH self-check semantics for user profiles with GitHub identity

## Backend Switching

Polaris now has a concrete cross-backend switch path rather than only a design
goal:

- operators can target `<project>@docker`
- operators can target `<project>@pod[:profile]`
- operators can target `<project>@kubevirt-vm`
- the selected backend can be persisted in `state/selection.json`
- when a requested backend spec is missing, Polaris can synthesize it from an
  existing source spec

This is one of Polaris's strongest isolation-specific differentiators.

## Current Boundaries

The current implementation deliberately does **not**:

- provide Coder-level production operations or governance maturity
- provide equal operational depth across all three backends
- hide KubeVirt guest probing complexity behind a richer guest agent model
- expose a full backend capability matrix or strong preflight diagnostics yet
- provide fine-grained repair actions for every backend-specific failure mode
