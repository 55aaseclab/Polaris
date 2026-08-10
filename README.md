# Polaris

Self-hosted workspace control plane.

## Overview

`Polaris` manages isolated development environments and external AI coding
agents across `docker`, `pod`, and `kubevirt-vm` backends.

This README is the source-owned onboarding guide. Cross-repository architecture,
operator runbooks, and release evidence live in the
[Jianxiaoyi documentation site](https://www.jianxiaoyitech.com/docs/).
Start with the [Polaris product docs](https://www.jianxiaoyitech.com/docs/polaris/)
for architecture and the
[Polaris 0.3.3 user-growth records](https://www.jianxiaoyitech.com/docs/operations/polaris-0.3.3/)
for release status.
Release history is maintained in [CHANGELOG.md](CHANGELOG.md).

## Local Development

Local stack service:

```bash
bash ./scripts/run-polaris-local-stack-service.sh .env.dev
```

You can also start it through the `stack` service in `paseo.json`.

Paseo runs through its Expo web development server in this stack. Changes under
`packages/paseo/source` use Fast Refresh and do not rebuild the Paseo web
artifact.
On the first run only, its shared package dependencies are compiled when their
upstream `dist` entry points are absent.

When you start `polaris server` outside the local stack wrapper, keep the same
runtime data root in every process. In local development that usually means
exporting:

```bash
POLARIS_DATA_ROOT=/path/to/polaris/data
```

If different host processes point at different `POLARIS_DATA_ROOT` values, the
portal can show workspace state that another process cannot resolve.

Local development uses `.env.dev`.
Polaris test commands also source `.env.dev` and use the same configured
`POLARIS_DATA_ROOT`.
Use `.env.dev.example` as the starting template.

The main values are:

```bash
POLARIS_DATA_ROOT=/path/to/polaris/data
POLARIS_NETFS_LOCAL_EXPORT_ROOT=/path/to/polaris/data/vault-data
POLARIS_BOOTSTRAP_ADMIN_USERS=<authing-username-1>,<authing-username-2>
POLARIS_SERVER_PORT=8787
POLARIS_PUBLIC_BASE_URL=http://HOST_IP:8081
POLARIS_PASEO_APP_BASE_URL=http://HOST_IP:8082
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

Minimal Polaris env:

```bash
POLARIS_DATA_ROOT=/path/to/polaris/data
POLARIS_NETFS_LOCAL_EXPORT_ROOT=/path/to/polaris/data/vault-data
POLARIS_SERVER_BIND_HOST=127.0.0.1
POLARIS_SERVER_PORT=8787
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

The repository developer CLI entry point is:

```bash
pnpm --dir apps/polaris run polaris --
```

Use it for workspace, user, credential, skill, and server commands while
working from the repository.

Telemetry can be enabled with PostHog and Sentry.
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

pnpm --dir apps/polaris run polaris -- vault skill-list <workspace> --user <user> --harness codex
pnpm --dir apps/polaris run polaris -- vault skill-install <workspace> <skillId> --user <user> --harness codex
pnpm --dir apps/polaris run polaris -- vault skill-uninstall <workspace> <skillId> --user <user> --harness codex
pnpm --dir apps/polaris run polaris -- vault skill-sync <workspace> --user <user> --harness codex
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

Remote production runs `polaris-server` as a host systemd service.
Docker keeps only the blue/green web stack (`paseo-app` and `nginx`).

The current default is:

```bash
POLARIS_DATA_ROOT=/srv/polaris/data
```

Optional access bootstrap:

```bash
POLARIS_BOOTSTRAP_ADMIN_USERS=<authing-username-1>,<authing-username-2>
```

Runtime note:

- workspace lifecycle operations run in-process inside `polaris-server`

Polaris separates workspace archive from workspace delete.

## Remote Rollback

```bash
bash ./scripts/rollback-remote.sh debian@your-server
```
