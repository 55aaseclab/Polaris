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

## Why It Matters

This model is what supports:

- project separation
- runtime separation
- controlled identity reuse
