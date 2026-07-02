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
The write path now uses a lock heartbeat and stale-lock recovery instead of
failing early while a stranded lock directory is still inside its TTL window.

Current lock behavior:

- mapping writes take an exclusive lock
- the lock emits a heartbeat while the writer is still alive
- stale recovery checks the heartbeat first, then the lock directory itself
- if a previous writer crashed, Polaris waits through the TTL window and then
  clears the stranded lock automatically

Polaris also applies a user-scoped mutation lock around user creation, user
deletion, profile edits, and user credential writes.
That lock also covers workspace create, archive, and delete operations.
Same-user control-plane mutations are serialized while a delete or
rollback-sensitive write is in progress.

Polaris now also applies a workspace lifecycle lock keyed by
`userId + workspace`.
That lock covers provision, switch, start, stop, archive, delete, live
credential switching, and workspace agent binding changes.
Workspace-scoped lifecycle writes now serialize even when they come from the
executor background path.

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
5. the backend should prefer local Clerk-user-id mapping when available, and
   avoid unnecessary Clerk profile fetches on already-mapped requests
6. the frontend enters `/users/<userId>/workspaces`

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

If the Clerk mapping step fails, Polaris rolls back the newly created profile
and user root instead of leaving partial user state behind.

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
- delete a Polaris user and its stored Clerk mapping together
- roll back the Polaris-side delete if filesystem cleanup fails partway through
- show admin role as configured state, not as an in-portal workflow

For first bootstrap, Polaris can also elevate named users through:

- `POLARIS_BOOTSTRAP_ADMIN_USERS`

## Current Server-Side Enforcement

Current portal API behavior now assumes Clerk-authenticated access.

That means:

- unauthenticated API requests are rejected
- normal users can access only their own Polaris user scope
- admin-only routes are enforced on the server side
- self-registration must match the authenticated Clerk identity

This matters for self-hosted teams because client-side routing is not treated
as the security boundary.

## Test Layers

Polaris now treats Clerk-backed testing as a separate live-auth layer.

Current split:

- normal Polaris tests recursively discover non-live backend tests without Clerk
- local live-auth tests load the minimal test env from `.env.test`
- browser registration and route tests live in Playwright E2E

Current commands:

```bash
pnpm --filter polaris run test
pnpm --filter polaris run test:live-auth
pnpm --filter polaris-web run test:live-auth
```

The goal is to keep default test runs independent from external auth, while
still keeping the real Clerk integration exercised in a dedicated group.

For local development, `pnpm --filter polaris run test:live-auth` and
`pnpm --filter polaris-web run test:live-auth` read repo-root `.env.test`.

That file should stay minimal.
It is not meant to mirror `.env.dev`.

Current expected contents include:

- `POLARIS_DATA_ROOT=./config`
- `POLARIS_NETFS_LOCAL_EXPORT_ROOT=./config/exports/workspaces`
- loopback executor vars for local tests
- `VITE_CLERK_PUBLISHABLE_KEY`
- `VITE_CLERK_DOMAIN`
- `VITE_CLERK_SIGN_IN_URL`
- `VITE_CLERK_SIGN_UP_URL`
- `CLERK_SECRET_KEY`

Use `.env.test.example` as the template.

## Frontend Runtime Configuration

Polaris frontend Clerk behavior is now explicit about satellite mode.

Current rules:

- `VITE_CLERK_DOMAIN` points to the Clerk frontend API host
- `VITE_CLERK_SIGN_IN_URL` and `VITE_CLERK_SIGN_UP_URL` define the auth entry
  pages
- cross-origin sign-in alone does not enable satellite mode
- `VITE_CLERK_SATELLITE_DOMAIN` is the only switch that enables satellite mode

Supported `VITE_CLERK_SATELLITE_DOMAIN` values:

- unset: no satellite mode
- `auto`: use the current browser host
- explicit hostname: use that hostname

This prevents Polaris from fabricating invalid Clerk asset URLs such as
workspace-domain-prefixed Clerk hosts when the deployment is not actually using
Clerk satellite mode.
