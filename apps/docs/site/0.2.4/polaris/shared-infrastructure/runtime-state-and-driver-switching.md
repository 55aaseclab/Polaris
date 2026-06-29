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
