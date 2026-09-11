# Polaris

Self-hosted control plane for agentic workflows.

## Features

Polaris owns identity, Vaults, workflow admission, and the public origin.

- Isolated Vaults on `docker`, `pod`, and `kubevirt-vm` backends
- Authing identity, ownership, sessions, quotas, lifecycle, and audit
- Portal work desk for Domain Pack runs, approval, and artifacts
- Polaris DSL packs, Host binding, and host or Vault execution
- Private-surface Gateway and the Paseo coding surface
- CLI for users, Vaults, packs, and operators

## Docs

This README is the source-owned onboarding guide. Product pages, operator
runbooks, and release evidence live in `apps/docs/site`.

```bash
pnpm run docs:dev
```

Serves VitePress on `http://127.0.0.1:4180`. From the parent workspace, the
same command is the `docs` service in `paseo.json`.

- [Polaris product docs](apps/docs/site/polaris/index.md) — Portal, Vaults,
  Gateway, Paseo, DSL, and CLI
- [Operations](apps/docs/site/operations/index.md) — deploy, gateway,
  incidents, and release records
- [CHANGELOG.md](CHANGELOG.md) — release history

## Local Development

```bash
# clone
git clone --recurse-submodules git@github.com:jianxiaoyitech/Polaris.git
cd Polaris
# init submodules
git submodule update --init --recursive
# copy and edit .env.dev (minimum below)
cp .env.dev.example .env.dev
# start the local stack
bash ./scripts/run-polaris-local-stack-service.sh .env.dev
```

Keep `POLARIS_AUTH_MODE=disabled` and `POLARIS_VAULT_MODE=host`. Authing
and Vault env are unused. Use one `POLARIS_DATA_ROOT` in every process.

Minimum `.env.dev`:

```bash
POLARIS_AUTH_MODE=disabled
POLARIS_AUTH_DEFAULT_USER_ID=100000000000000001
POLARIS_VAULT_MODE=host
POLARIS_DATA_ROOT=/path/to/polaris/data
```

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
