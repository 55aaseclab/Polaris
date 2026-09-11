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
runbooks, and release evidence live on the
[Jianxiaoyi documentation site](https://www.jianxiaoyitech.com/docs/).

- [Polaris product docs](https://www.jianxiaoyitech.com/docs/polaris/) —
  Portal, Vaults, Gateway, Paseo, DSL, and CLI
- [Operations](https://www.jianxiaoyitech.com/docs/operations/) — deploy,
  gateway, incidents, and release records
- [Polaris 0.3.4](https://www.jianxiaoyitech.com/docs/operations/polaris-0.3.4/)
  — current release state
- [0.3.3 capacity records](https://www.jianxiaoyitech.com/docs/operations/polaris-0.3.3/)
  — 20-vault baseline
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

Keep `POLARIS_AUTH_MODE=disabled`. Authing vars are unused. Use one
`POLARIS_DATA_ROOT` in every process.

Minimum `.env.dev`:

```bash
POLARIS_AUTH_MODE=disabled
POLARIS_AUTH_DEFAULT_USER_ID=100000000000000001
POLARIS_DATA_ROOT=/path/to/polaris/data
POLARIS_NETFS_LOCAL_EXPORT_ROOT=/path/to/polaris/data/vault-data
POLARIS_SERVER_BIND_HOST=0.0.0.0
POLARIS_SERVER_PORT=8787
POLARIS_PUBLIC_BASE_URL=http://127.0.0.1:8787
POLARIS_PASEO_APP_BIND_HOST=0.0.0.0
POLARIS_PASEO_APP_PORT=8082
POLARIS_PASEO_APP_BASE_URL=http://127.0.0.1:8082
POLARIS_PORTAL_ALLOWED_ORIGINS=http://127.0.0.1:8787,http://127.0.0.1:8082
POLARIS_WANGHAI_GATEWAY_ORIGIN=http://127.0.0.1:8787
POLARIS_WANGHAI_GATEWAY_MASTER_SECRET=replace-with-at-least-32-random-characters
POLARIS_WANGHAI_DOCKER_GATEWAY_HOST=127.0.0.1
```

## Polaris CLI

The repository developer CLI entry point is:

```bash
pnpm --dir apps/polaris run polaris --
```

The Polaris-owned literature-review workflow definition and runtime live in
`packs/autoresearch`; its reusable implementations live once under
`tools/`. They are independent of Wanghai:

```bash
pnpm --dir apps/polaris run polaris -- literature-review version
pnpm --dir apps/polaris run polaris -- literature-review plan
pnpm --dir apps/polaris run polaris -- literature-review visualize \
  --format png --output literature-review-workflow.png
pnpm --dir apps/polaris run polaris -- literature-review test
```

Set `POLARIS_LITERATURE_WORKSPACES_ROOT`,
`POLARIS_LITERATURE_CACHE_ROOT`, and
`POLARIS_LITERATURE_RUNTIME_MODE=local` for a local run. See the workflow
README at `packs/autoresearch/README.md` for the PDF visualization
command, provider settings, review modes, collection-review continuation, and
the full run command. The visualizer is a static Graphviz projection and does
not need the literature workspace or cache. Integrated mode is intentionally
fail-closed and requires a Polaris durable job with a disposable execution
cell.

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

Repository-provided skills are kept under `skills/` and can be installed with
the same installer.  The migrated business and research routers are:

- `polaris-business`
- `polaris-content-production`
- `polaris-data-collection`
- `polaris-intelligence-analysis`
- `polaris-order-ops`
- `polaris-outreach`
- `polaris-report-writing`
- `polaris-ads-system-setup`

For example:

```bash
pnpm --dir apps/polaris exec tsx scripts/install-skills.ts \
  --target codex polaris-business polaris-data-collection
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
