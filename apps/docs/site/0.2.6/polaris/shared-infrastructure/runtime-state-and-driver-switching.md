# Runtime State And Driver Switching

This document explains how Polaris keeps runtime state persistent while still
allowing backend and driver changes.

## What Your Team Gets

Teams usually want two things at the same time:

- runtime state that stays with the workspace
- the ability to scale across different backends and infrastructure models

## Current Model

Polaris keeps runtime persistence in workspace-owned state instead of tying it
only to one backend realization.

That is what makes it possible to:

- keep workspace runtime state attached to the workspace
- re-render or restart the runtime
- switch the backend realization when needed

Supported backend families today include:

- `docker`
- `pod`
- `kubevirt-vm`

## Why It Matters

This is the basis for:

- state continuity during normal operations
- backend portability
- scaling across different infrastructure choices

## Portal State Model

The portal should treat persisted workspace status as the primary lifecycle
signal.

That means the top-level workspace action area is driven by `status.json`,
but not by a separate `status.state` field. The current lifecycle signal is
mainly:

- `status.operation`
- `status.health.backendLiveness`
- `status.health.workspaceReadiness`
- `status.health.reason`

Supporting runtime and configuration facts live in:

- `status.driver`
- `status.credentials`
- `status.attachments`
- `status.runtimeAssembly`

The important operator rule is:

- in-flight lifecycle intent is explained by `operation`
- live runtime truth is explained by `health`
- driver details are supporting information, not the primary action state

Current commonly-seen `backendLiveness` values include:

- `running`
- `stopped`
- `missing`

In practice this means:

- `status.operation.kind` should survive a page refresh while an executor
  action is still in flight
- `status.health.backendLiveness` should stay a live runtime fact instead of a
  synthetic UI transition label
- the portal should not rely only on local in-memory UI state for these
  transitions
- the system should not expose or depend on a separate `provision.json`
  progress model for user-visible lifecycle state
- portal detail reads may refresh runtime observations, but they should
  rewrite canonical status instead of doing field-by-field stale merges
- portal list reads should return the workspace list immediately instead of
  blocking on per-workspace status refresh
- driver-specific facts such as runtime kind or runtime reference belong in
  the driver details area

The current persisted schema no longer exposes:

- `status.state`
- `status.backend`
- `lifecycleAction`
- `health.daemonReadiness`
- top-level `ssh`
- top-level `drift`

The portal also avoids presenting a summarized `Paseo status` line because it
collapses multiple low-level signals into a misleading single conclusion.

Instead, the portal should prefer the reconnect metadata that actually drives
embedded Paseo:

- persisted `server-id`
- persisted `pairing.json`
- reconnect target derived from those two files

Polaris no longer derives reconnect metadata from `paseo daemon status`.

The current rule is:

- `serverId` comes only from `~/.paseo/server-id`
- pair link comes only from `~/.paseo/pairing.json`
- the portal reads those files when it needs reconnect metadata instead of
  trusting a cached status payload

Polaris-generated Paseo runtime config also disables default local voice
features now.

Current defaults are:

- `"dictation": false`
- `"voiceMode": "disabled"`

This keeps runtime state smaller and avoids unnecessary voice-related local
artifacts in normal Polaris workspaces.

## Embedded Paseo Behavior

When the workspace pane embeds Paseo, Polaris should preserve already-running
workspace frames across workspace switches.

That means:

- switching from one running workspace to another should not force the first
  workspace iframe to reload
- switching through a stopped workspace should not discard the hidden iframe
  for a different running workspace
- a stopped workspace should remove only its own active iframe and leave the
  pane empty instead of trying to reconnect

The backend readiness gate is also file-based now:

- wait for `~/.paseo/server-id` to become non-empty
- wait for `~/.paseo/pairing.json` to contain a `url`

This avoids blocking workspace readiness on the heavier `paseo daemon status`
command.
