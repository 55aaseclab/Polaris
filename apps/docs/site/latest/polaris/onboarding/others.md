# Other Onboarding Notes

This page keeps the onboarding material that is still useful but more
operator-facing than customer-facing.

## Main Entry Points

The repo exposes three main Polaris surfaces:

- CLI and services:

```bash
pnpm --dir apps/polaris run polaris --
```

- local web portal:

```bash
pnpm --filter polaris-web exec vite --host 0.0.0.0
```

- local stack wrapper:

```bash
bash ./scripts/run-polaris-local-stack-service.sh .env.dev
```

## Stack Topology

Polaris has four runtime pieces:

1. `polaris-server`
2. `polaris-executor`
3. `polaris-web`
4. `paseo-app`

Responsibilities:

- `polaris-server` serves the portal API and reads persisted workspace state
- `polaris-executor` performs lifecycle work that may be slow or side-effecting
- `polaris-web` provides the browser UI
- `paseo-app` renders the pairing portal for a workspace daemon

## Service Ports

Default local ports:

- `6767`: Paseo daemon inside a workspace
- `8082`: Paseo web app
- `8787`: Polaris portal API
- `8788`: Polaris executor API
- `8081`: Polaris web portal in local dev mode

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
pnpm --filter ./apps/polaris-web run build
bash ./scripts/run-polaris-local-stack-service.sh .env.dev
```
