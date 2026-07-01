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

The portal should treat workspace state as the primary lifecycle signal.

That means the top-level workspace action area is driven by the persisted
workspace state, not by a separate synthesized driver-runtime label or a
separate provisioning-progress file.

Current persisted workspace states are:

- `creating`
- `not-applied`
- `starting`
- `saved`
- `stopping`
- `ready`
- `archiving`
- `degraded`
- `unsupported`

The important operator rule is:

- the workspace status explains the lifecycle of the workspace as a whole
- driver details are supporting information, not the primary action state

In practice this means:

- `creating`, `starting`, `stopping`, and `archiving` should survive a page refresh
- the portal should not rely only on local in-memory UI state for these
  transitions
- the system should not expose or depend on a separate `provision.json`
  progress model for user-visible lifecycle state
- portal detail reads may refresh runtime observations, but they should merge
  with existing lifecycle state instead of blindly overwriting it
- portal list reads should return the workspace list immediately instead of
  blocking on per-workspace status refresh
- driver-specific facts such as runtime kind or runtime reference belong in
  the driver details area

The portal also avoids presenting a summarized `Paseo status` line because it
collapses multiple low-level signals into a misleading single conclusion.

Instead, the portal should prefer raw connection details such as:

- daemon address
- server id
- reconnect target

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
