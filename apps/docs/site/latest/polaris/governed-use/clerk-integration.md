# Clerk Integration

This page explains how Clerk authentication is connected to Polaris user and
workspace behavior.

## Core Principle

Clerk provides the authenticated login identity.
Polaris provides the user, credential, and workspace control-plane identity.

## Clerk Mapping

Clerk-to-Polaris mapping is kept separately from user profile fields.

Current mapping storage:

- `config/users/user-map.json`

Current writes to that mapping file are serialized and committed atomically.

Typical mapping keys include:

- `clerkUserId`
- `clerkUsername`

Mapped result:

- `polarisUserId`
- access role and plan

## Login And Registration Flow

Current login flow:

1. user signs in through Clerk
2. the frontend reads Clerk identity
3. the backend verifies the Clerk session before serving Polaris API routes
4. the backend resolves Clerk-to-Polaris mapping
4. the frontend enters `/users/<userId>/workspaces`

Current registration flow:

1. user completes Clerk sign-up
2. Polaris creates the user record
3. Polaris creates required default user material
4. Polaris writes stable Clerk mapping
5. the frontend enters the user workspace home

Current registration defaults create:

- the Polaris user profile
- required default user material
- the Clerk mapping

They do not implicitly create a default Codex provider credential.

## Portal Responsibilities

### Login / Registration

- establish Clerk session
- trigger Polaris user creation or user mapping lookup

### Profile

- show user details
- manage user-owned credentials
- create, delete, and activate credentials

### Administration

The portal now includes an admin view for user-level access control.

That admin flow can:

- review portal users
- inspect Clerk mappings
- surface mapping-only, profile-only, and missing-user-root integrity states
- promote a mapped user to `admin`
- demote a mapped user back to `user`
- block direct user deletion while Clerk mappings still exist
- keep the delete button visible, but disabled, while a Clerk mapping still exists

For first bootstrap, Polaris can also elevate named users through:

- `POLARIS_BOOTSTRAP_ADMIN_USERS`

If a user is elevated through `POLARIS_BOOTSTRAP_ADMIN_USERS`, that admin role
is treated as locked.

That means:

- the portal keeps the demote action visible
- the demote action is disabled in the admin view
- the backend rejects direct demotion requests for that user

## Current Server-Side Enforcement

Current portal API behavior now assumes Clerk-authenticated access.

That means:

- unauthenticated API requests are rejected
- normal users can access only their own Polaris user scope
- admin-only routes are enforced on the server side
- self-registration must match the authenticated Clerk identity

This matters for self-hosted teams because client-side routing is not treated
as the security boundary.
