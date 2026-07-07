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

## New Workspaces Versus Existing Workspaces

For a new workspace, Polaris already goes through the shared foundation path
during create and provision work.

That means:

- a newly created workspace picks up the latest shared template state
- if the matching shared image already exists, Polaris reuses it
- if it does not exist yet, Polaris builds it once and then tags the workspace
  image from it

For an existing workspace, `stop` and `start` are intentionally lighter.

That means:

- `start` brings the existing workspace runtime back up
- `start` does not implicitly rebuild the shared base image path
- if the shared template changed and you want the existing workspace to move to
  that new base, you should run `rebuild`

In short:

- new workspace: automatically picks up the latest shared base
- existing workspace: use `rebuild` to migrate to a new shared base

## Shared Source Of Truth

The shared Docker foundation now has one repo-level source of truth:

- `config/docker/workspace-prebuilt.Dockerfile`

Shared base tool definitions also live beside it:

- `config/docker/base-tools/README.md`
- `config/docker/base-tools/apt-packages.txt`
- `config/docker/base-tools/python-packages.txt`
- `config/docker/base-tools/node-packages.txt`
- `config/docker/base-tools/install-base-tools.sh`

This means the common Docker foundation is no longer anchored to a demo user
directory.

## User-Level Sync Copy

Polaris still materializes a user-local Dockerfile copy at:

- `config/users/<userId>/docker/workspace-prebuilt.Dockerfile`

That file is now a synced working copy, not the canonical template.

Current behavior:

- the repo-level template in `config/docker/` is authoritative
- scaffold and provision flows sync that template into the selected user root
- image reuse still hashes the effective user-local Dockerfile that the
  workspace build actually uses

This keeps one shared maintenance point while preserving per-user build inputs
inside the normal Polaris data layout.

Useful implementation references:

- `apps/polaris/scripts/config/provision.ts`
- `apps/polaris/scripts/config/scaffold.ts`
- `apps/polaris/scripts/executor/operations.ts`

## Executor Data Root

Polaris runtime services do not read workspace data from the repo checkout by
default.

They read from `POLARIS_DATA_ROOT`.

For local development, the server and executor must agree on the same data
root. If one process points at `config/` while another points at a separate
runtime data directory, workspace state and workspace config resolution will
drift.

Useful log events:

- `workspace-shared-image-build`
- `workspace-image-reused`
- `workspace-image-tag`
