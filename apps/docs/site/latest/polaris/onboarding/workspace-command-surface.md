# Workspace Command Surface

This document explains the command surface Polaris exposes for workspace
lifecycle operations.

## What Your Team Gets

The customer-facing value is not a collection of raw Docker, Pod, or VM
commands.

It is one workspace-oriented command surface that covers:

- create
- start
- stop
- restart
- rebuild
- status
- archive
- delete

## Root Entry

```bash
pnpm --dir apps/polaris run polaris -- ...
```

## Core Commands

### Create

```bash
pnpm --dir apps/polaris run polaris -- create <workspace> --user <userProfileId>
```

Current semantics:

- create the workspace saved spec
- bind the target user
- initialize the default backend path
- for Docker-backed provisioning, prepare the current shared base image path
  for the new workspace

### Start

```bash
pnpm --dir apps/polaris run polaris -- start <workspaceRef>
```

Current semantics:

- start the backend runtime
- wait until backend and runtime assembly are usable
- do not implicitly rebuild the workspace image foundation

### Rebuild

```bash
pnpm --dir apps/polaris run polaris -- rebuild <workspaceRef>
```

Current semantics:

- re-evaluate the provisioned image path for the workspace
- sync the current shared Docker template into the user-local Dockerfile copy
- rebuild or reuse the shared base image as needed
- recreate the backend runtime from that refreshed image path

### Stop

```bash
pnpm --dir apps/polaris run polaris -- stop <workspaceRef>
```

Current semantics:

- stop the current workspace runtime
- keep the workspace saved spec

### Status

```bash
pnpm --dir apps/polaris run polaris -- status <workspaceRef>
```

Current semantics:

- inspect backend existence and running state
- inspect attachment presence
- inspect runtime assembly
- inspect daemon and service readiness
- synthesize `status.json`

### Archive

```bash
pnpm --dir apps/polaris run polaris -- archive <workspaceRef>
```

Current semantics:

- remove the workspace from the active workspace list
- preserve the workspace copy under the user archive root
- preserve workspace-owned saved runtime state under the archive root

### Delete

```bash
pnpm --dir apps/polaris run polaris -- delete <workspaceRef>
```

Current semantics:

- remove the workspace saved spec
- remove the backend realization
- remove workspace-owned state
- do not create an archive copy
