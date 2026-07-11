# Polaris

Self-hosted workspace control plane.

## Overview

`Polaris` manages isolated development environments and external AI coding
agents across `docker`, `pod`, and `kubevirt-vm` backends.

## Local Deployment

Stage-one local deployment is separate from local development.

Main local deployment entry points:

```bash
polaris install
polaris start
polaris doctor
```

Desktop entry:

- `Polaris` app icon

Stage-one local deployment supports:

- Linux
- macOS
- Windows
- single-machine Docker-only runtime

It does not use `vite` dev server or `tsx watch`.

Release packaging targets now include:

- Debian `.deb`
- Windows `.zip` bundle with `.exe` launchers
- macOS `.app.zip`

Telemetry can be enabled with `PostHog` and `Sentry`.
Use `.env.dev.example` for the current environment variables.

## Local Development

Main CLI:

```bash
pnpm run polaris -- status <workspace>
```

Local stack service:

```bash
bash ./scripts/run-polaris-local-stack-service.sh .env.dev
```

You can also start it through the `stack` service in `paseo.json`.

When you start `polaris server` or `polaris executor` outside the local stack
wrapper, keep the same runtime data root in every process. In local
development that usually means exporting:

```bash
POLARIS_DATA_ROOT=/home/debian/jianxiaoyi/data/polaris/data
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
POLARIS_BOOTSTRAP_ADMIN_USERS=<clerk-username-1>,<clerk-username-2>
POLARIS_SERVER_PORT=8787
POLARIS_WEBPORTAL_PORT=8081
POLARIS_EXECUTOR_PORT=8788
POLARIS_EXECUTOR_SHARED_SECRET=change-this-to-a-long-random-secret
VITE_PASEO_APP_BASE_URL=http://HOST_IP:8082
POLARIS_PASEO_APP_BASE_URL=http://HOST_IP:8082
VITE_CLERK_SIGN_IN_URL=http://HOST_IP:8000/sign-in/
VITE_CLERK_SIGN_UP_URL=http://HOST_IP:8000/sign-up/
```

Minimal local test env:

```bash
POLARIS_DATA_ROOT=./config
POLARIS_NETFS_LOCAL_EXPORT_ROOT=./config/exports/workspaces
POLARIS_EXECUTOR_BASE_URL=http://127.0.0.1:8788
POLARIS_EXECUTOR_SHARED_SECRET=test-executor-shared-secret
VITE_CLERK_PUBLISHABLE_KEY=pk_test_xxx
VITE_CLERK_DOMAIN=clerk.your-domain.example
VITE_CLERK_SIGN_IN_URL=http://127.0.0.1:8000/sign-in/
VITE_CLERK_SIGN_UP_URL=http://127.0.0.1:8000/sign-up/
CLERK_SECRET_KEY=sk_test_xxx
```

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
POLARIS_DATA_ROOT=/home/debian/jianxiaoyi/data/polaris/data
```

Optional access bootstrap:

```bash
POLARIS_BOOTSTRAP_ADMIN_USERS=<clerk-username-1>,<clerk-username-2>
```

Executor requirements:

- `POLARIS_EXECUTOR_SHARED_SECRET` is required
- the executor binds only to `127.0.0.1`

Polaris now separates workspace archive from workspace delete.

## Remote Rollback

```bash
bash ./scripts/rollback-remote.sh debian@your-server
```
