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

In operational terms, the effective identity is:

- `userId`
- `workspace`

not only:

- `workspace`

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

Current onboarding defaults create managed SSH material.
They do not implicitly create a default Codex provider credential.

Current CLI entry:

```bash
pnpm --dir apps/polaris run polaris -- user create <userProfileId>
```

### User Deletion

If user deletion is executed, Polaris currently removes:

- the user profile
- user credentials and generated material
- the user's workspace directories
- the Clerk-to-Polaris mapping

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

### Default Credential Selection

Default credential selection is a user-level decision.

That means a user can:

- activate one credential as the current default
- change that default later
- let workspaces resolve the user's active credential by default

This default-selection path is separate from workspace runtime `live-switch`.

## Why This Matters

This model gives teams:

- clearer accountability
- less credential sprawl
- a cleaner separation between login identity and operational identity
- a better foundation for user-scoped workspace control

## Related Docs

- [credential-switch.md](./credential-switch.md)
