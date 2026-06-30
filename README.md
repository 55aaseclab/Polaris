# Polaris

Self-hosted workspace control plane.

## Overview

`Polaris` manages isolated development environments and external AI coding
agents across `docker`, `pod`, and `kubevirt-vm` backends.

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

Local development requires `.env.dev`.

The main values are:

```bash
POLARIS_DATA_ROOT=/path/to/polaris/data
POLARIS_BOOTSTRAP_ADMIN_USERS=cyruscyliu
POLARIS_SERVER_PORT=8787
POLARIS_WEBPORTAL_PORT=8081
POLARIS_EXECUTOR_PORT=8788
VITE_PASEO_APP_BASE_URL=http://HOST_IP:8082
POLARIS_PASEO_APP_BASE_URL=http://HOST_IP:8082
VITE_CLERK_SIGN_IN_URL=http://HOST_IP:8000/sign-in/
VITE_CLERK_SIGN_UP_URL=http://HOST_IP:8000/sign-up/
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
- backup dir: `/home/debian/jianxiaoyi/data/polaris/backups`

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
POLARIS_BOOTSTRAP_ADMIN_USERS=cyruscyliu
```

Polaris now separates workspace archive from workspace delete.

## Remote Rollback

```bash
bash ./scripts/rollback-remote.sh debian@your-server
```
