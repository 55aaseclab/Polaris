# Remote Deploy

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
- active color: `/etc/polaris/active-color`
- host nginx upstream file: `/etc/nginx/conf.d/polaris-gateway-upstream.conf`

Provision installs:

- `docker.io`
- `docker-compose-plugin`
- `nginx`
- `rsync`
- `curl`
- `git`
- Node.js 22
- `pnpm`

Remote Docker entrypoint:

- `deploy/docker-compose.polaris-bluegreen.yml`

Then:

1. Fill `/etc/polaris/polaris.env`
2. Keep production user data under `/srv/polaris/data`
3. Ensure host nginx forwards the public Polaris domain to
   `127.0.0.1:8080`

## Remote Deploy

```bash
bash ./scripts/cd-remote.sh debian@your-server
```

This runs local CI, rsyncs the repo, deploys the inactive color, then switches
the host upstream file.

## Remote Rollback

```bash
bash ./scripts/rollback-remote.sh debian@your-server
```
