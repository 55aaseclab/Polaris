# Polaris surfaces and route ownership

Deployment topology (fixed):

- **paseo-web** runs **outside** the workspace container (one shared coding UI).
- **paseo daemon** runs **inside** each workspace container (`:6767`).
- **wanghai server** (vertical) runs **inside** the workspace container (`:9090`),
  not as a global host process.

Monorepo packages:

| Package | Role |
| --- | --- |
| `@qingniao/polaris-shell` | Outer door: auth, user management, host directory |
| `@qingniao/surface-paseo` | Coding surface: `/h/...` left/right IDE routes only |
| `@qingniao/surface-wanghai` | Vertical surface: request the Polaris gateway route |

## Route ownership

### Shell (`@qingniao/polaris-shell`)

Owned by the outer control chrome. No agent timeline, no terminal pane.

| Path | Purpose |
| --- | --- |
| `/` (when no host selected) | Shell home / host picker entry |
| `/welcome` | Sign-in / disabled-auth bounce |
| `/auth/callback` | OAuth / Authing callback |
| `/settings` | Shell settings root (optional) |
| `/settings/user` | User management (profile, credentials, defaults) |
| `/hosts` | Host directory (list / create / start-stop entry) |

Shell may deep-link **into** surfaces; it does not own their internal paths.

### Paseo surface (`@qingniao/surface-paseo`)

Coding agent UI after a host is selected. Process: **outer paseo-web** talking
to **in-container paseo daemon**.

| Path | Purpose |
| --- | --- |
| `/h/:serverId` | Host root (left/right chrome) |
| `/h/:serverId/workspace/:workspaceId` | Workspace |
| `/h/:serverId/agent/:agentId` | Agent stream |
| `/h/:serverId/open-project` | Open / create project flow |
| `/h/:serverId/sessions` | Sessions list |
| `/h/:serverId/new` | New agent / draft |
| `/h/:serverId/settings` | **Host-local** IDE settings only |

Not shell: login, global user admin, global host catalog.

### Wanghai surface (`@qingniao/surface-wanghai`)

Vertical industry UI entry from shell. **Server is private in-container.**

| Path / action | Purpose |
| --- | --- |
| Shell action `open-wanghai-portal` | Open the Polaris-authorized surface route |
| Outer route `/v/:serverId/wanghai` | Thin embed page that first requests a gateway launch |

No second global Wanghai deployment. The browser receives neither a container
port nor a NodePort. Polaris resolves the private target after authorization.

## Product assembly (per user, one stack)

Do **not** pick coding vs vertical with a server env var. One polaris deployment
serves everyone; the **logged-in user** (and the workspaces they create) decide
the flavor:

```text
polaris-coding   = shell + surface-paseo
polaris-vertical = shell + surface-paseo + surface-wanghai
```

User subscription has **two axes** (user-map / session):

| Field | Values | Meaning |
| --- | --- | --- |
| `line` | `coding` \| `vertical` | Product family (which surfaces) |
| `plan` | `free` \| `pro` | Feature richness within that line (kept; not used for line) |

Resolve via `@qingniao/polaris-shell` `resolveProductForUser({ line, surfaces })`
from the logged-in user — never a host env like `POLARIS_PRODUCT`.

Vertical workspace runtime (inside **that user's** container):

```text
paseo daemon :6767
wanghai portal :9090
```
