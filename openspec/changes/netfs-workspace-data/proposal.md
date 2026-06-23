## Why

Backend switching currently treats the large project data attachment as
something that must be copied between runtime implementations. That is slow,
fragile, and a poor fit for cross-node operation, where Docker and pod-based
backends may run on different hosts while still needing one shared project
view.

## What Changes

- Define `workspace-data` as a netfs-backed durable attachment with explicit
  source metadata instead of backend-local volume semantics.
- Keep `workspace-runtime-state`, `user-identity-state`, and
  `user-ssh-state` as smaller attachments that remain migratable during backend
  switches.
- Require backend renderers to realize the same `workspace-data` contract on
  Docker, pod, and VM-oriented runtimes without introducing per-user or
  per-backend config forks.
- Exclude `workspace-data` from copy-based backend-switch migration once the
  shared netfs contract is active.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `attachment-config-schema`: add an explicit netfs-backed source model for
  attachment declarations.
- `workspace-attachments`: define `workspace-data` as the shared project data
  attachment that persists across backend changes without duplication.
- `workspace-attachment-lifecycle`: update lifecycle rules so backend switches
  migrate only the smaller state attachments while `workspace-data` remains the
  shared durable store.

## Impact

Affected areas include workspace config loading and validation, backend
renderers for Docker and pod/VM runtimes, provisioning flows that materialize
attachments, and backend-switch behavior. The change also introduces an
operator-facing storage dependency on a reachable netfs service for
`workspace-data`.
