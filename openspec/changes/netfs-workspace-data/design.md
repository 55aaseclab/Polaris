## Context

`workspace-data` holds the large project tree and related workspace-local
outputs. The current backend model still realizes that attachment through
backend-local storage primitives, which makes Docker and pod backends behave as
if the project data must be copied during a driver switch. That is expensive,
creates drift risk, and breaks down further when the source and destination
backends run on different nodes.

The current switch flow already treats only three attachments as migratable:
`workspace-runtime-state`, `user-identity-state`, and `user-ssh-state`.
This change aligns the storage model with that existing switch behavior by
making `workspace-data` a shared store instead of a migrated one.

## Goals / Non-Goals

**Goals:**

- Define one backend-neutral source model for shared `workspace-data`.
- Keep `workspace-data` stable across Docker, pod, and VM-oriented backends.
- Preserve copy-based migration only for the three smaller state attachments.
- Keep the user-scoped and runtime-scoped attachment model intact.

**Non-Goals:**

- Converting every attachment source kind to netfs.
- Replacing the existing small-state migration flow.
- Committing to one storage vendor such as Longhorn for project data.
- Solving general multi-writer coordination beyond the current
  single-workspace-per-project model.

## Decisions

### 1. Add an explicit `netfs` attachment source kind

`workspace-data` needs a first-class source kind instead of being inferred from
backend-specific PVC or Docker volume behavior. The saved attachment config
should declare a `netfs` source directly, with backend-neutral fields for the
shared location and mount behavior.

Alternatives considered:

- Reuse `persistent-volume`: rejected because it encodes Kubernetes-style
  storage semantics and does not describe Docker consumption cleanly.
- Keep implicit backend-local mapping: rejected because it preserves duplicate
  state and backend-specific truth.

### 2. Scope netfs to `workspace-data` first

This change should apply only to `workspace-data`. The other durable
attachments are smaller, already modeled as migratable state, and do not need
the operational overhead of shared network storage.

Alternatives considered:

- Move all durable attachments to netfs: rejected because it adds cost and
  complexity where copy-based migration is already acceptable.
- Introduce separate source models for every attachment immediately: rejected
  because it widens the rollout surface without a current need.

### 3. Backend renderers must realize one shared storage contract

The Docker, pod, and KubeVirt paths may mount the shared storage differently,
but they must all realize the same logical `workspace-data` attachment. The
workspace spec remains the single source of truth; generated manifests are only
backend-specific realizations of that contract.

Alternatives considered:

- Add backend-specific user config for the same project: rejected because it
  would reintroduce forked storage truth.
- Keep Docker on local volumes while pod uses shared storage: rejected because
  switching would still require data movement.

### 4. Backend switch remains a small-state migration

Switch operations should continue to export and import only
`workspace-runtime-state`, `user-identity-state`, and `user-ssh-state`.
`workspace-data` should be validated as reachable on both backends rather than
copied between them.

Alternatives considered:

- Continue copying `workspace-data` as a fallback: rejected because it hides
  storage misconfiguration and preserves slow, failure-prone behavior.

## Risks / Trade-offs

- [Netfs availability becomes a hard dependency] -> Fail early during
  provisioning or apply when the shared storage cannot be resolved or mounted.
- [Remote I/O may be slower than local disk] -> Limit netfs usage to
  `workspace-data` and keep latency-sensitive small state on their current
  attachment model.
- [Mount semantics differ by backend] -> Validate the logical contract in the
  shared config model and keep backend-specific mount logic behind drivers.
- [A misconfigured shared path could leak data across projects] -> Derive the
  final shared location from workspace identity and validate collisions before
  realization.

## Migration Plan

1. Extend the attachment config model to declare `netfs` for
   `workspace-data`.
2. Update provisioning so newly generated workspace specs use the shared source
   model for project data and preserve existing sources for the smaller
   attachments.
3. Update backend renderers and validation so each backend can realize the same
   shared project root.
4. Keep switch migration limited to the three small attachments and fail if the
   destination backend cannot attach the shared project store.
5. Migrate existing saved workspace specs for active users to the new source
   shape before relying on backend switching.

Rollback: restore the prior saved attachment source for `workspace-data` and
re-render backend manifests. No data copy rollback should be required because
the goal is to preserve one shared project store as the source of truth.

## Open Questions

- Which concrete netfs fields should be mandatory in saved config:
  server/export, URI, or a higher-level storage reference?
- Should backend realization mount netfs directly, or resolve a pre-mounted
  host path where the environment already manages the network filesystem?
- Do we need an explicit readiness signal that distinguishes backend health
  from shared-storage reachability for status output?
