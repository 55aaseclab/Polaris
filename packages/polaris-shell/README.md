# `@qingniao/polaris-shell`

Outer Polaris control chrome (doorway):

- auth / session entry routes
- user management (`/settings/user`)
- host directory (`/hosts`)
- product assembly from the **current user** subscription

## Subscription (per user)

| Field | Values | Meaning |
| --- | --- | --- |
| `line` | `coding` \| `vertical` | Product family / surfaces |
| `plan` | `free` \| `pro` | Feature richness (kept; not used for line yet) |

`resolveProductForUser({ line })` — never deploy env, never use `plan` to pick the line.

## Topology

- Shell UI runs **outside** workspace containers (with paseo-web).
- Wanghai server stays **in-container** for vertical workspaces.
- **One stack** serves all users.

## Migration from Paseo patches

See `SHELL_USER_MIGRATION_SOURCES` in `src/user.ts`. Route ownership:
`apps/docs/site/polaris/surfaces-and-routes.md`.
