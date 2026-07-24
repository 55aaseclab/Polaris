# Local Deployment

This page describes stage-one local deployment for Polaris.

It is not the same thing as local development.

Local development is for repo contributors.
Local deployment is for users who want a stable local install.

## Stage-One Scope

Stage one supports:

- Linux
- macOS
- Windows
- single-machine deployment
- Docker-only runtime
- one-shot GUI and CLI control actions

Stage one does not support:

- `pod`
- `kubevirt-vm`
- host nginx
- blue/green deploy
- `systemd`
- a resident local control service
- `vite` dev server
- `tsx watch`

## Main Entry Points

Installed CLI:

```bash
polaris install
polaris start
polaris stop
polaris doctor
polaris open
```

Desktop entry:

- `Polaris` app icon

The installed desktop app uses the same one-shot local deployment actions as
the CLI.

Repo-only development entry points still exist for contributors:

```bash
pnpm run polaris:local-deploy -- desktop
pnpm run polaris:local-deploy -- start
```

## Shared Lifecycle Actions

Stage one defines one shared local deployment control model:

- `install`
- `start`
- `stop`
- `restart`
- `status`
- `open`
- `logs`
- `doctor`
- `upgrade`
- `uninstall`

These actions do not require a resident Polaris control daemon.
Each action runs and exits.

## Release Artifacts

Stage one ships through native release artifacts.

Current target outputs include:

- Debian `polaris_<version>_amd64.deb`
- Windows `polaris_<version>_win_x64_setup.exe`
- macOS `polaris_<version>_macos_x64.dmg`

The Debian package installs both:

- `polaris`
- the `Polaris` desktop app entry

The Windows installer installs:

- `bin/polaris.exe`
- `bin/polaris-desktop.exe`
- a colocated `bundle/` runtime directory
- a desktop shortcut for `Polaris`

The macOS disk image includes:

- `Polaris.app`
- `polaris_<version>_macos_x64.dmg`
- a bundled runtime directory inside the app package
- a bundled `polaris` CLI binary alongside the app inside the mounted image

## Runtime Shape

Stage-one local deployment uses:

- a dedicated Docker Compose bundle
- fixed built containers instead of development servers
- a persistent local data root
- an nginx gateway container instead of host-network assumptions

The stage-one bundle starts:

- `polaris-control-plane`
- `paseo-app`
- `polaris-local-gateway`

## Local Data Root

Default data-root conventions:

- Linux: `~/.local/share/polaris`
- macOS: `~/Library/Application Support/Polaris`
- Windows: `%LOCALAPPDATA%\\Polaris`

You can override the default with:

```bash
POLARIS_LOCAL_DEPLOY_DATA_ROOT=/path/to/polaris-data
```

## Diagnostics

The stage-one `doctor` action checks at least:

- Docker is installed
- Docker is running
- the local gateway port is available
- the local data root can be prepared

Example:

```bash
polaris doctor
```

## Telemetry

Polaris now supports a combined telemetry setup with:

- `PostHog` for product, install, environment, and runtime events
- `Sentry` for captured exceptions and error reporting

The stage-one local deployment path emits five telemetry categories:

- distribution
- environment
- runtime
- product
- error

Typical events include:

- install, upgrade, and uninstall lifecycle
- Docker checks, image pulls, and bundle resolution
- app launch, portal readiness, and shutdown
- workspace, credential, and AI access actions
- API failures, unhandled exceptions, and runtime action failures

To enable telemetry in stage-one local deployment, set:

```bash
POLARIS_TELEMETRY_ENABLED=1
POLARIS_POSTHOG_API_KEY=phc_xxx
POLARIS_POSTHOG_HOST=https://us.i.posthog.com
POLARIS_SENTRY_DSN=https://examplePublicKey@o0.ingest.sentry.io/0
POLARIS_SENTRY_ENVIRONMENT=production
POLARIS_TELEMETRY_ENVIRONMENT=production
```

For the bundled web portal, telemetry configuration is baked into the release
image at build time rather than read dynamically at container runtime.

When you build release images yourself, also set:

```bash
VITE_POLARIS_TELEMETRY_ENABLED=1
VITE_POLARIS_POSTHOG_KEY=phc_xxx
VITE_POLARIS_POSTHOG_HOST=https://us.i.posthog.com
VITE_POLARIS_SENTRY_DSN=https://examplePublicKey@o0.ingest.sentry.io/0
VITE_POLARIS_SENTRY_ENVIRONMENT=production
```

Current telemetry intentionally avoids collecting:

- prompt content
- file contents
- API keys and tokens
- raw local absolute paths
- customer business data

## Local Development Is Separate

This is the development-only entry point:

```bash
bash ./scripts/run-polaris-local-stack-service.sh .env.dev
```

They are useful for development.
They are not the default stage-one local deployment path.
