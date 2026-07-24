# Ownership Model

This document explains how Polaris models ownership for users, workspaces, and
credentials.

## Core Principle

Polaris separates four related but different things:

- Clerk authentication
- Polaris users
- workspaces
- user-owned credentials

The practical rule is:

- Clerk owns login state
- Polaris owns user records
- workspaces belong to Polaris users
- credentials belong to Polaris users, not to individual workspaces

## What Is Owned By What

### Users

Polaris users are business identities keyed by `userId`.

They carry:

- name
- email
- GitHub account data
- SSH policy
- agent identity defaults
- the list of workspaces they own

Clerk does not replace this layer.
It only provides authenticated login identity.

### Workspaces

A workspace belongs to one Polaris user.

Current ownership rules:

- one workspace belongs to one user
- one user can own many workspaces
- the same project name is not shared globally without user scope
- archived workspace names still reserve that name for the same user

In operational terms, the effective identity is:

- `userId`
- `workspace`

not only:

- `workspace`

When a workspace is no longer needed day to day, Polaris can archive it
without treating removal as silent destruction.

That means the active workspace list becomes smaller, while an archived copy
and its saved runtime state can still be retained under the user archive root.

It also means a user cannot immediately recreate another active workspace with
the same name while an archived workspace of that name still exists under that
same user.

### Credentials

Credentials are user-owned reusable objects.

Current examples include:

- `ssh-key`
- `codex-auth`
- `claude-auth`
- `copilot-auth`
- `opencode-auth`
- `pi-auth`

Polaris models them at user scope so one user can:

- hold multiple credentials
- activate a default credential
- reuse a credential across workspaces

## Files And Control Points

- user profile:
  `config/users/profiles/<userId>.yaml`
- user credentials:
  `config/users/<userId>/credentials/*.yaml`
- user workspaces:
  `config/users/<userId>/workspaces/<workspace>/`
- Clerk mapping:
  `config/users/user-map.json`

## Lifecycle

### User Creation

User creation currently does three important things:

1. create the Polaris user record
2. create required default credential material for the user profile
3. write Clerk-to-Polaris mapping if provided

Current onboarding defaults always create managed SSH material.
When `POLARIS_AI_ACCESS_PROVIDER_BACKEND=new-api`, onboarding also provisions a
default `codex-new-api` credential, marks it active, and lets new workspaces
inherit that credential as the default `agent-auth` binding.

User creation now holds a user-scoped mutation lock while it scaffolds the
profile, creates default credential material, and writes Clerk mapping data.

If the Clerk mapping write fails, Polaris removes the newly scaffolded profile
and user root instead of leaving an orphaned Polaris user behind.

If the incoming registration flow carries a Polaris invite code, user creation
stores that code on the Polaris profile under referral metadata.
That invite code is not only UI state.
When AI access opens the user's first `new-api` account, Polaris reuses the
stored code as the upstream `aff_code`.
This keeps Polaris registration referral state aligned with `new-api`
affiliate rewards.

Current CLI entry:

```bash
pnpm --dir apps/polaris run polaris -- user create <userProfileId>
```

### User Deletion

If user deletion is executed, Polaris currently removes:

- the user profile
- user credentials and generated material
- the Clerk-to-Polaris mapping
- the user-scoped workspace root when no workspace data remains

User deletion is now rejected when workspace data still exists under that user.

That includes:

- active workspaces
- archived workspaces

The admin portal keeps the delete action visible for admins.
It now deletes the Polaris user record and the stored Clerk mapping together in
one operation.

If filesystem deletion fails partway through, Polaris restores the user profile,
user root, and mapping state instead of leaving a half-deleted user behind.

User deletion also runs under the same user-scoped mutation lock used by
profile and credential writes.
That prevents same-user profile or credential mutations from racing the delete
flow while it is in progress.

It does not delete the Clerk platform user object itself.

Current CLI entry:

```bash
pnpm --dir apps/polaris run polaris -- user delete <userProfileId>
```

### Credential Creation

Credential creation happens at user scope.

That means a user can add new credentials without tying them to one specific
workspace first.

Current user credential creation supports:

- harness-specific credential types
- multiple credentials per user
- generated material written under the user credential root

Typical outputs include:

- `config/users/<userId>/credentials/<credentialId>.yaml`
- harness-specific generated files under
  `config/users/<userId>/credentials/...`

### Credential Deletion

Credential deletion also happens at user scope.

When a credential is deleted, Polaris removes:

- the credential registry entry
- the generated material for that credential

This keeps credential lifecycle aligned with user ownership instead of
workspace ownership.

The portal no longer returns raw credential file content in preview responses.

Credential file paths can still be listed, but secret material is intentionally
hidden from browser previews.

### Default Credential Selection

Default credential selection is a user-level decision.

That means a user can:

- activate one credential as the current default
- change that default later
- let workspaces resolve the user's active credential by default

This default-selection path is separate from workspace runtime `live-switch`.

### Workspace Archive

Workspace lifecycle now separates active use from archived retention.

When a workspace is archived, Polaris:

- removes it from the active workspace list
- removes it from the user's active workspace index
- preserves the archived workspace copy under the user archive root
- keeps user-scoped identity and credential state separate from workspace
  lifecycle

Current CLI entry:

```bash
pnpm --dir apps/polaris run polaris -- archive <workspaceRef>
```

### Workspace Delete

Workspace delete is now separate from workspace archive.

When a workspace is deleted, Polaris:

- removes the workspace copy
- removes workspace-owned runtime state
- removes it from the user's active workspace index
- does not keep an archive copy

Current CLI entry:

```bash
pnpm --dir apps/polaris run polaris -- delete <workspaceRef>
```

### TODO

- add workspace restore from the user archive root
- restore archived workspace state back into the active workspace list
- reject restore when the active workspace name already exists
- add portal restore action for archived workspaces
- reduce reliance on `withFakePath` command stubs by adding more real backend
  smoke and integration coverage for workspace lifecycle flows

## Why This Matters

This model gives teams:

- clearer accountability
- less credential sprawl
- a cleaner separation between login identity and operational identity
- a better foundation for user-scoped workspace control
- a safer default for self-hosted user administration
- a safer delete path for users that still have live Clerk ownership links

## Related Docs

- [credential-switch.md](./credential-switch.md)
