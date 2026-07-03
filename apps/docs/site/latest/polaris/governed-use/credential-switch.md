# Credential Switch

This document explains how Polaris switches credentials in day-to-day runtime
use.

## Core Principle

Polaris has two different credential paths:

- user-level credential ownership and activation
- workspace runtime credential switching

They are related, but they are not the same action.

## User-Level Credential Model

Polaris models credentials at user scope.

That means a user can:

- create credentials
- activate a default credential
- keep multiple credentials for the same harness
- reuse those credentials across workspaces

Current harness examples include:

- `ssh`
- `codex`
- `claude`
- `copilot`
- `opencode`
- `pi`

Current user credential command surface includes:

```bash
pnpm --dir apps/polaris run polaris -- user credential add <userProfileId> ...
pnpm --dir apps/polaris run polaris -- user credential list <userProfileId>
pnpm --dir apps/polaris run polaris -- user credential read <userProfileId> <credentialId>
pnpm --dir apps/polaris run polaris -- user credential write <userProfileId> <credentialId> <fileKey> --content <value>
pnpm --dir apps/polaris run polaris -- user credential activate <userProfileId> <credentialId>
pnpm --dir apps/polaris run polaris -- user credential delete <userProfileId> <credentialId>
```

The portal mirrors that model.

Current portal behavior:

- credentials are grouped by harness tabs
- creating a credential starts from the current harness tab
- reading a credential opens the managed material for that credential record
- writing a credential updates a named managed file key on that record

## Runtime Credential Switching

Runtime switching exists for supported harnesses in running workspaces.

The flow is:

1. the user selects a credential for a harness
2. Polaris validates the harness-to-credential relationship
3. Polaris writes the selected material into runtime identity state
4. Polaris updates the workspace live selection
5. status refresh reflects the active runtime identity

This changes the runtime identity in use.
It does not rebuild the whole workspace.

## What It Is Not

Runtime `live-switch` is not the same as:

- user credential creation
- user credential activation
- workspace creation
- daemon type switching

There is also an older compatibility path for workspace-level `agent-auth`
binding and unbinding.

That path:

- updates driver spec binding state
- re-renders and restarts the driver

It is a workspace-spec override path.
It is not the same as runtime live switch.

## Command And Portal Surfaces

The main runtime command surface is:

```bash
pnpm --dir apps/polaris run polaris -- live-switch <workspaceRef> <credentialId> \
  [--harness <ssh|codex|claude|copilot|opencode|pi>]
```

Current semantics:

- only applies to running workspaces
- validates backend support for live switch
- validates harness and credential alignment
- writes material into `user-identity-state`
- writes the live selection
- refreshes status

The portal also exposes runtime credential switch behavior as part of workspace
operation.

For user-owned credential management, the portal now uses typed
`record`/`file` read-write operations instead of the older preview flow.

That means:

- users create supported credential types through typed credential actions
- credential file paths can still be listed
- credential reads return managed files for one credential record
- credential writes target a named managed file key on that record

## Why This Matters

This model gives teams:

- faster credential changes without full environment rebuild
- clearer control over which runtime identity is active
- separation between user-owned credentials and workspace runtime selection
