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
- skill-list
- skill-install
- skill-uninstall
- skill-sync

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

### User Skill Registry

```bash
pnpm --dir apps/polaris run polaris -- user skill list <userProfileId>
pnpm --dir apps/polaris run polaris -- user skill add <userProfileId> --source <repo-or-source> --skill <skillName> [--harness <codex|claude>]
pnpm --dir apps/polaris run polaris -- user skill remove <userProfileId> <skillId>
```

Current semantics:

- keep user-owned skills declarative
- store source plus concrete skill selection
- do not install into the user home at registry write time

### Workspace Skill List

```bash
pnpm --dir apps/polaris run polaris -- skill-list <workspaceRef> --user <userProfileId> --harness <codex|claude>
```

Current semantics:

- read installed runtime skills for the selected harness
- prefer runtime backend inspection for running docker and pod workspaces
- hide internal directories such as `.system`

### Workspace Skill Install

```bash
pnpm --dir apps/polaris run polaris -- skill-install <workspaceRef> <skillId> --user <userProfileId> --harness <codex|claude>
```

Current semantics:

- resolve the selected user skill registry entry
- materialize it into the running workspace only
- for `codex`, download via `skills` and then copy into `/identity/codex/skills`
- for `claude`, install directly into `CLAUDE_HOME/skills`

### Workspace Skill Uninstall

```bash
pnpm --dir apps/polaris run polaris -- skill-uninstall <workspaceRef> <skillId> --user <userProfileId> --harness <codex|claude>
```

Current semantics:

- remove the installed runtime skill for the selected harness
- keep the user registry entry intact

### Workspace Skill Sync

```bash
pnpm --dir apps/polaris run polaris -- skill-sync <workspaceRef> --user <userProfileId> --harness <codex|claude>
```

Current semantics:

- reconcile runtime installs against the user registry
- install missing declared skills
- remove unmanaged installed skills
