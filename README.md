# Polaris

Self-hosted workspace control plane.

## Overview

`Polaris` manages isolated development environments and external AI coding
agents across `docker`, `pod`, and `kubevirt-vm` backends.

## Local Development

Local stack service:

```bash
bash ./scripts/run-polaris-local-stack-service.sh .env.dev
```

You can also start it through the `stack` service in `paseo.json`.

Paseo runs through its Expo web development server in this stack. Changes under
`apps/paseo/source` use Fast Refresh and do not rebuild the Paseo web artifact.
On the first run only, its shared package dependencies are compiled when their
upstream `dist` entry points are absent.

When you start `polaris server` or `polaris executor` outside the local stack
wrapper, keep the same runtime data root in every process. In local
development that usually means exporting:

```bash
POLARIS_DATA_ROOT=/path/to/polaris/data
POLARIS_EXECUTOR_BASE_URL=http://127.0.0.1:8788
POLARIS_EXECUTOR_SHARED_SECRET=change-this-to-a-long-random-secret
```

If the server and executor point at different `POLARIS_DATA_ROOT` values, the
portal can show workspace state that the executor cannot resolve.

Local development requires `.env.dev`.

Live-auth tests use `.env.test`.
That file should contain the minimal test runtime env, not the local stack env.
Use `.env.test.example` as the starting template.

The main values are:

```bash
POLARIS_DATA_ROOT=/path/to/polaris/data
POLARIS_NETFS_LOCAL_EXPORT_ROOT=/path/to/polaris/data/exports/workspaces
POLARIS_BOOTSTRAP_ADMIN_USERS=<authing-username-1>,<authing-username-2>
POLARIS_SERVER_PORT=8787
POLARIS_EXECUTOR_PORT=8788
POLARIS_EXECUTOR_SHARED_SECRET=change-this-to-a-long-random-secret
POLARIS_PUBLIC_BASE_URL=http://HOST_IP:8081
POLARIS_PASEO_APP_BASE_URL=http://HOST_IP:8082
POLARIS_DOCS_PORT=4180
POLARIS_AUTHING_APP_ID=your-authing-app-id
POLARIS_AUTHING_APP_SECRET=your-authing-app-secret
POLARIS_AUTHING_ISSUER=https://your-tenant.authing.cn/oidc
POLARIS_AUTHING_JWKS_URL=https://your-tenant.authing.cn/oidc/.well-known/jwks.json
POLARIS_AUTHING_AUTHORIZATION_URL=https://your-tenant.authing.cn/oidc/auth
POLARIS_AUTHING_TOKEN_URL=https://your-tenant.authing.cn/oidc/token
POLARIS_AUTHING_LOGOUT_URL=https://your-tenant.authing.cn/oidc/session/end
POLARIS_AUTHING_LOGOUT_REDIRECT_URI=http://HOST_IP:5173
POLARIS_AUTHING_REDIRECT_URI=http://HOST_IP:8082/auth/callback
```

Minimal local test env:

```bash
POLARIS_DATA_ROOT=./config
POLARIS_NETFS_LOCAL_EXPORT_ROOT=./config/exports/workspaces
POLARIS_SERVER_BIND_HOST=127.0.0.1
POLARIS_SERVER_PORT=8787
POLARIS_EXECUTOR_BASE_URL=http://127.0.0.1:8788
POLARIS_EXECUTOR_SHARED_SECRET=test-executor-shared-secret
POLARIS_AUTHING_APP_ID=your-authing-app-id
POLARIS_AUTHING_APP_SECRET=your-authing-app-secret
POLARIS_AUTHING_ISSUER=https://your-tenant.authing.cn/oidc
POLARIS_AUTHING_JWKS_URL=https://your-tenant.authing.cn/oidc/.well-known/jwks.json
POLARIS_AUTHING_AUTHORIZATION_URL=https://your-tenant.authing.cn/oidc/auth
POLARIS_AUTHING_TOKEN_URL=https://your-tenant.authing.cn/oidc/token
POLARIS_AUTHING_LOGOUT_URL=https://your-tenant.authing.cn/oidc/session/end
POLARIS_AUTHING_LOGOUT_REDIRECT_URI=http://127.0.0.1:5173
POLARIS_AUTHING_REDIRECT_URI=http://127.0.0.1:8082/auth/callback
```

## Polaris CLI

The repo developer CLI entry point is:

```bash
pnpm --dir apps/polaris run polaris --
```

Use it for workspace, user, credential, skill, server, and executor commands
while working from the repo.

Telemetry can be enabled with `PostHog` and `Sentry`.
Use `.env.dev.example` for the current environment variables.

## Workspace Skills

Polaris splits skills into two layers:

- user registry: declarative skill descriptors only
- workspace runtime: materialized installs inside the running workspace

Current CLI surface:

```bash
pnpm --dir apps/polaris run polaris -- user skill list <user>
pnpm --dir apps/polaris run polaris -- user skill add <user> --source <repo-or-source> --skill <skillName> [--harness codex|claude]
pnpm --dir apps/polaris run polaris -- user skill remove <user> <skillId>

pnpm --dir apps/polaris run polaris -- skill-list <workspace> --user <user> --harness codex
pnpm --dir apps/polaris run polaris -- skill-install <workspace> <skillId> --user <user> --harness codex
pnpm --dir apps/polaris run polaris -- skill-uninstall <workspace> <skillId> --user <user> --harness codex
pnpm --dir apps/polaris run polaris -- skill-sync <workspace> --user <user> --harness codex
```

Current runtime behavior:

- `codex`: Polaris uses `skills` as a downloader, then copies the installed
  skill into `/identity/codex/skills`
- `claude`: Polaris installs directly into `CLAUDE_HOME/skills`
- runtime skill listing is resolved from the running backend with `docker exec`
  or `kubectl exec`, not from host-side path inspection

## Local CI

```bash
bash ./scripts/ci-local.sh
```

## Remote Provision

```bash
bash ./scripts/provision-remote.sh debian@your-server
```

Default remote paths:

- app dir: `/srv/polaris/app`
- data dir: `/srv/polaris/data`
- env file: `/etc/polaris/polaris.env`
- active color file: `/etc/polaris/active-color`
- nginx upstream file: `/etc/nginx/snippets/polaris-gateway-upstream.conf`

## Remote Deploy

```bash
bash ./scripts/cd-remote.sh debian@your-server
```

Production uses `.env.prod`.

Production data lives under `POLARIS_DATA_ROOT` instead of the repo checkout.

The current default is:

```bash
POLARIS_DATA_ROOT=/srv/polaris/data
```

Optional access bootstrap:

```bash
POLARIS_BOOTSTRAP_ADMIN_USERS=<authing-username-1>,<authing-username-2>
```

Executor requirements:

- `POLARIS_EXECUTOR_SHARED_SECRET` is required
- the executor binds only to `127.0.0.1`

Polaris now separates workspace archive from workspace delete.

## Remote Rollback

```bash
bash ./scripts/rollback-remote.sh debian@your-server
```
