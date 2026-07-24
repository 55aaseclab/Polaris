# Other Onboarding Notes

This page keeps the onboarding material that is still useful but more
operator-facing than customer-facing.

## Main Entry Points

The repo exposes separate local deployment and local development surfaces.

- Local deployment CLI:

```bash
pnpm run polaris:local-deploy -- start
pnpm run polaris:local-deploy -- doctor
```

- Local deployment GUI:

```bash
pnpm run polaris:local-deploy -- desktop
```

- CLI and services for development and operator workflows:

```bash
pnpm --dir apps/polaris run polaris --
```

- local stack wrapper for development:

```bash
bash ./scripts/run-polaris-local-stack-service.sh .env.dev
```

That wrapper also starts the Docker bridge proxy for the local executor, so
workspace containers can report runtime status and Paseo pairing metadata back
through `host.docker.internal:8788`.

## Stack Topology

Polaris has three runtime pieces:

1. `polaris-server`
2. `polaris-executor`
3. `paseo-app`

Responsibilities:

- `polaris-server` serves the portal API and reads persisted workspace state
- `polaris-executor` performs lifecycle work that may be slow or side-effecting
- `paseo-app` provides the browser UI and renders the pairing portal for a
  workspace daemon

## Service Ports

Default development ports:

- `6767`: Paseo daemon inside a workspace
- `8082`: Paseo web app
- `8787`: Polaris portal API
- `8788`: Polaris executor API

## Data Ownership

Polaris code and Polaris data are separate concerns.

Code lives in this repo.
User and workspace data live under `POLARIS_DATA_ROOT`.

Polaris should not start without that variable.
Missing runtime data-root configuration is treated as a startup error, not as
a signal to fall back into the checked-out repo tree.

Important roots:

- `POLARIS_DATA_ROOT/users`
- `POLARIS_DATA_ROOT/state`
- `POLARIS_NETFS_LOCAL_EXPORT_ROOT`

## Workspace Lifecycle

The normal Docker onboarding path is:

```text
user profile
-> workspace spec
-> provisioned image
-> rendered backend manifest
-> runtime start
-> daemon ready
-> pairing target ready
```

Generated manifests are rendered artifacts, not hand-maintained source files.

## Recommended Local Flow

```bash
pnpm --dir apps/polaris run polaris -- user create <userProfileId>
pnpm --dir apps/polaris run polaris -- create <project> --user <userProfileId>
pnpm --dir apps/polaris run polaris -- render <project>@docker
pnpm --dir apps/polaris run polaris -- start <project>@docker
pnpm --dir apps/polaris run polaris -- status <project>@docker
pnpm --dir apps/polaris run polaris -- logs <project>@docker
```

## Validation

Minimum local validation:

```bash
pnpm install
pnpm --filter polaris exec tsc -p tsconfig.json --noEmit
bash ./scripts/run-polaris-local-stack-service.sh .env.dev
```
