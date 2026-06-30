# Shared Docker Foundation

This document explains the shared Docker foundation behind standard Polaris
workspaces.

## What Your Team Gets

For onboarding, teams usually do not want every workspace to behave like a
fresh bespoke machine build.

They want:

- one standard environment
- one predictable default toolchain
- less manual setup per member
- less repeated rebuild cost

## How Polaris Handles It

For standard Docker workspaces, Polaris moves toward one shared Docker
foundation instead of one full image build per workspace.

The practical intent is:

- standard workspaces begin from the same prepared base
- equivalent setups reuse the same image outcome
- new members do not need to rebuild the whole environment story from zero

## Current Realization

Today Polaris prefers shared prebuilt image reuse for Docker-backed
workspaces.

The practical flow is:

1. define the workspace
2. resolve the effective Dockerfile input
3. compute a digest for the prebuilt foundation
4. reuse the shared image if it already exists
5. tag it into the workspace runtime image
6. continue with render and start

Useful implementation references:

- `apps/polaris/scripts/config/provision.ts`
- `apps/polaris/scripts/config/scaffold.ts`
- `apps/polaris/scripts/executor/operations.ts`

Useful log events:

- `workspace-shared-image-build`
- `workspace-image-reused`
- `workspace-image-tag`
