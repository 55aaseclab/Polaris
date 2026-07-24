# Isolation Boundary

This document explains the isolation boundary Polaris gives each workspace.

## What Your Team Gets

Polaris does not rely on one undifferentiated home directory to define
isolation.

Instead, it separates:

- workspace data
- workspace runtime state
- user identity state
- ephemeral runtime state

## Current Model

The important boundaries are:

- `workspace-data`
- `workspace-runtime-state`
- `user-identity-state`
- `ephemeral-runtime`

Current semantics:

- `workspace-data` belongs to the workspace itself
- `workspace-runtime-state` belongs to the workspace itself
- `user-identity-state` belongs to the user and is mounted into the workspace
- `ephemeral-runtime` is temporary runtime-only state

## Executor Boundary

Polaris also treats the executor as part of the isolation boundary.

Current self-hosted behavior:

- the executor must have `POLARIS_EXECUTOR_SHARED_SECRET`
- the executor binds only to `127.0.0.1`
- portal-to-executor calls must present the shared secret

This reduces the chance that workspace lifecycle operations are exposed as a
separate unauthenticated network surface.

## Why It Matters

This model is what supports:

- project separation
- runtime separation
- controlled identity reuse
