# Control Plane Maturity

This document describes the current Polaris control plane as a workspace
orchestration boundary around backend drivers and the Paseo manager layer.

## Purpose

Polaris owns workspace intent, config loading, backend dispatch, runtime
observation, drift synthesis, reconcile planning, and durable state surfaces.

Paseo is the first manager/orchestrator implementation that Polaris assembles
into those workspaces and then inspects through an explicit manager boundary.

## Scope And Files

Polaris now keeps control-plane intent, generated backend artifacts, runtime
status, backend selection, and manager/evolution state separate.

| Concern | Contents | Control-plane source of truth | Runtime / user-facing realization |
|---|---|---|---|
| CLI entrypoint | Operator command surface for lifecycle and switching | `apps/polaris/scripts/cli/main.ts` | `pnpm --dir apps/polaris run polaris -- ...` |
| Saved workspace intent | Project, backend, attachments, user profile, credentials, runtime, service, and manager settings | `config/users/<user>/projects/<project>/<backend>.agent.yaml` | none |
| Generated backend artifact | Rendered backend manifest | `config/users/<user>/projects/<project>/generated/<backend>.yaml` | `docker compose`, `kubectl apply`, or KubeVirt objects |
| Driver selection state | Preferred backend and optional profile | `config/users/<user>/projects/<project>/state/selection.json` | default resolution for ambiguous `<project>` references |
| Status snapshot | Synthesized backend, attachment, runtime, daemon, SSH, and drift state | `config/users/<user>/projects/<project>/state/status.json` | `polaris status <project>` output |
| Backend registry | Control-plane mapping from backend kind to backend driver | `apps/polaris/scripts/backends/index.ts` | dispatch to `docker`, `pod`, or `kubevirt-vm` drivers |
| Runtime controller | Drift and reconcile logic over normalized observations | `apps/polaris/scripts/core/runtime-controller.ts` | `status` and `reconcile` output |
| User profile | User identity and ownership boundary used by workspace loading | `config/users/profiles/<user>.yaml` | selected by `user_profile` in workspace specs |
| Credential registry | User-owned auth declarations and material references | `config/users/<user>/credentials/*.yaml` | resolved into identity and SSH attachments |
| Paseo manager state | Durable manager runtime state | saved spec attachment `workspace-runtime-state` | assembled into `~/.paseo` from `/workspace/state/paseo` |
| Evolution state | Memory snapshots, execution events, and reviewed memory candidates | saved spec attachment `workspace-runtime-state` | `/workspace/state/paseo/evolution` |

## Polaris Today

Polaris now behaves like a real control plane instead of a thin renderer.

Current control-plane responsibilities:

- parse CLI commands and normalize project references
- load and validate a normalized workspace object
- resolve backend choice and optional pod profile
- resolve user profile and credential bindings
- render generated backend artifacts as derived outputs
- dispatch lifecycle actions through backend drivers
- inspect live backend state and synthesize workspace status
- compute drift and generate reconcile plans
- persist operator-facing state such as backend selection and status snapshots
- prepare evolution memory snapshots before executable runs

Current command surface:

- `user create`
- `user delete`
- `create`
- `render`
- `apply`
- `start`
- `stop`
- `restart`
- `rebuild`
- `status`
- `reconcile`
- `logs`
- `switch`

## Polaris And Paseo

Polaris and Paseo are separate layers.

Polaris owns:

- workspace spec loading
- attachment semantics
- user and credential resolution
- backend driver dispatch
- readiness policy
- status and drift synthesis
- reconcile planning
- evolution-state persistence and review flow

Paseo owns:

- manager daemon process inside the workspace
- manager-local state under the assembled `~/.paseo` surface
- pairing offer generation
- daemon reachability and connectivity behavior

The current integration boundary is explicit:

- Polaris bootstraps Paseo into the workspace
- Polaris starts the Paseo daemon when agent support is enabled
- Polaris inspects Paseo through daemon status, persisted server ID, and
  pairing-file checks
- Polaris records lifecycle and runtime events around Paseo rather than
  treating Paseo internals as the control-plane source of truth

That boundary is mature enough to be useful, but it is still Paseo-first.

## UI And UX

Compared with Coder, Polaris is much less mature on UI and operator UX.

Coder currently exposes a productized web UX around the control plane:

- workspace creation from the Templates tab in the UI
- template creation from starter templates and duplication flows in the UI
- workspace filtering in the UI by owner, name, template, status, outdated,
  dormant, agent state, and health
- bulk workspace actions in the UI such as update, delete, start, and stop
- schedule settings in the UI for autostart, autostop, and inactivity-driven
  shutdown
- a browser-based agent UX through Coder Agents, which is documented as a chat
  interface and API inside the Coder control plane

Polaris today exposes none of that as a first-class web product.

Polaris UI/UX today is primarily:

- CLI-first
- repo-first
- file-backed
- operator-oriented rather than self-serve end-user-oriented

That means Polaris has strong explicit control-plane semantics, but the user
experience is still closer to "operate a precise infrastructure tool" than
"use a polished workspace platform."

For Polaris itself, the current UX strengths are:

- one consistent CLI surface across user create, user delete, create, render,
  apply, start, status, reconcile, logs, and switch
- explicit generated files and state snapshots that are easy to inspect
- explicit backend targeting through `<project>@<backend>`
- explicit status and drift output instead of opaque lifecycle failures

For Polaris itself, the current UX gaps versus Coder are:

- no web UI for creating, viewing, filtering, or repairing workspaces
- no template gallery or starter-template UX
- no bulk operator actions
- no built-in scheduling UX
- no native control-plane chat UX for agent workflows
- no admin UX for policy, governance, or audit exploration

So on UI/UX, the comparison is straightforward:

- Coder has the more mature product interface
- Polaris has the more explicit repo-native control-plane model
- Polaris still needs a real UI layer before it can compete on operator or
  developer experience

## Control Plane Loop

Polaris currently runs this control-plane sequence:

```text
CLI command
  -> project reference resolution
  -> workspace config load
  -> workspace validation
  -> optional config synthesis/provisioning
  -> backend driver dispatch
  -> backend observation
  -> drift synthesis
  -> status and/or reconcile output
  -> state snapshot persistence
```

For executable commands on agent-enabled workspaces, Polaris also runs:

```text
workspace load
  -> prepare evolution memory snapshot
  -> execute backend action
  -> append lifecycle evolution events
  -> finalize evolution session
```

This is the part that makes Polaris more than "run docker compose" or "run
kubectl apply."

## Workspace Object

The normalized workspace object is the center of the control plane.

It currently carries:

- workspace identity
- workspace profile defaults
- user profile identity
- resolved credentials and credential bindings
- backend kind and profile
- attachment classes
- runtime settings
- manager contract
- connectivity settings
- lifecycle capabilities
- runtime invariants
- health policy

This is important because Polaris reasons about one workspace model first and
only later maps that model onto Docker, Pod, or KubeVirt.

## Backend Driver Model

Polaris currently supports three backend drivers:

- `docker`
- `pod`
- `kubevirt-vm`

All three drivers now participate in the same broad workspace lifecycle shape:

- workspace creation
- `start`
- `stop`
- `restart`
- `rebuild`
- `render`
- `apply`
- `logs`
- `inspect`
- `executeReconcilePlan`

This is a meaningful maturity step for Polaris itself.

The backend surface is still uneven:

- `pod` has the deepest Kubernetes-native inspection path
- `docker` is the default onboarding and simplest operator path
- `kubevirt-vm` has a real driver but still depends on heavier guest probing

## Observation And Drift

Polaris now treats status as a synthesized control-plane view instead of a thin
backend-local response.

Current observation covers:

- backend existence and liveness
- attachment presence
- runtime home assembly
- Codex, Claude, and SSH assembly
- Paseo daemon status
- Paseo pairing-file integrity
- declared versus observed service presence
- SSH self-check semantics for GitHub-backed user profiles

Current drift output is then used to produce:

- workspace state such as `ready`, `degraded`, or `not-applied`
- operator-readable health reasons
- a reconcile plan with actions such as `render`, `apply`, `restart-runtime`,
  `repair-runtime-assembly`, or `report-unrecoverable-drift`

## User And Credential Control Plane

Polaris also now has real control-plane semantics for user and credential
resolution.

Current user semantics:

- each workspace selects one user profile
- one user profile can own many workspaces
- project names cannot currently collide across multiple users
- scaffold flows can create a local user profile and update its workspace list

Current credential semantics:

- credentials are user-owned registry entries
- workspace specs bind credentials by purpose
- the selected user profile constrains which credentials are legal
- registry credentials override legacy inline auth when direct bindings exist
- resolved credentials are mapped onto identity or SSH attachment classes

This is control-plane work, not backend templating work.

## Current Reality

Polaris today is strongest as:

- a repo-native control plane
- a normalized workspace object model
- an explicit attachment and user boundary
- a shared driver contract over multiple isolation backends
- a status/drift/reconcile layer above backend APIs
- a manager boundary around Paseo instead of a hard-coded monolith

Polaris today is weaker as:

- a polished multi-user product
- an API/UI platform
- a deeply audited governance layer
- a backend-parity-complete operations platform
- a manager-agnostic ecosystem beyond the current Paseo-first path

## Current Boundaries

The current implementation deliberately does **not**:

- provide a web UI or API-first control-plane product
- provide first-class multi-tenant runtime naming across colliding project
  names
- make Paseo fully replaceable in day-to-day operator flows yet
- provide equal inspection and repair depth across all backend drivers
- treat backend manifests as the source of truth
- embed Codex or Claude as built-in Polaris harnesses
