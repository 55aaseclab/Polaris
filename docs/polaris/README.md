# Polaris

`polaris` is rooted at:

```bash
pnpm --dir apps/polaris run polaris --
```

## Service Ports

Polaris currently uses four distinct ports in the operator stack:

- `6767`: Paseo daemon inside a workspace.
- `8082`: Self-hosted Paseo web app.
- `8787`: Polaris portal API when started directly from the repo.
- `4173`: Polaris web portal frontend in local dev mode.

## Default Path

Use `docker` as the clean default onboarding path.

Source of truth and flow:

```text
apps/polaris/scripts/polaris.ts
-> config/users/<user>/workspaces/<project>/docker.agent.yaml
-> config/users/<user>/workspaces/<project>/generated/docker.yaml
-> docker compose runtime
```

Polaris owns the saved spec and generated output. Treat generated manifests as
rendered artifacts, not hand-maintained files.

## Recommended Flow

Create a user first:

```bash
pnpm --dir apps/polaris run polaris -- user create <userProfileId>
```

Then create a workspace spec for that user:

```bash
pnpm --dir apps/polaris run polaris -- create <project> --user <userProfileId>
```

Then stage bootstrap secrets and render/start the workspace:

```bash
pnpm --dir apps/polaris run polaris -- render <project>
pnpm --dir apps/polaris run polaris -- start <project>
```

Check health and inspect logs:

```bash
pnpm --dir apps/polaris run polaris -- status <project>
pnpm --dir apps/polaris run polaris -- logs <project>
```

For more operator trace output during lifecycle commands:

```bash
POLARIS_LOG_LEVEL=debug pnpm --dir apps/polaris run polaris -- start <project>
```

If the same project name exists in multiple backend directories, target the
intended one explicitly:

```bash
pnpm --dir apps/polaris run polaris -- status <project>@docker
pnpm --dir apps/polaris run polaris -- logs <project>@kubevirt-vm
```

## Command Model

The main workspace lifecycle commands are:

- `user create`
- `create`
- `render`
- `apply`
- `start`
- `stop`
- `restart`
- `rebuild`
- `status`
- `reconcile`
- `logs`
- `switch`
- `live-switch`
- `delete`

## Credentials And Bootstrap

Credential metadata lives in a pure file-backed registry:

```text
config/users/profiles/<user>.yaml
config/users/<user>/credentials/*.yaml
```

## External Agent Contract

Polaris does not provide a built-in coding harness.

The contract is:

- Polaris targets a manager contract, not a hard-coded daemon product name
- `Paseo` is the first workspace manager/orchestrator adapter
- `Codex` and `Claude` are external harnesses bootstrapped into the workspace
- Polaris is responsible for workspace assembly, secrets bootstrap, daemon
  startup, evolution-state persistence, and status/drift reporting
- Harness behavior is external to Polaris

## Validation

```bash
pnpm install
pnpm exec tsc -p tsconfig.json --noEmit
pnpm --dir apps/polaris run polaris -- render <project>
pnpm --dir apps/polaris run polaris -- status <project>
```

## More Docs

- [portal-business-flow.md](./portal-business-flow.md)
- [isolation-maturity.md](./isolation-maturity.md)
- [agent-swarm-maturity.md](./agent-swarm-maturity.md)
- [evolution-maturity.md](./evolution-maturity.md)
