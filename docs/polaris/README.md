# Polaris

`polaris` is rooted at:

```bash
pnpm exec tsx scripts/polaris.ts
```

## Default Path

Use `docker` as the clean default onboarding path.

Source of truth and flow:

```text
scripts/polaris.ts
-> config/specs/docker/projects/<project>.agent.yaml
-> config/generated/docker/<project>.yaml
-> docker compose runtime
```

Polaris owns the saved spec and generated output. Treat generated manifests as
rendered artifacts, not hand-maintained files.

## Recommended Flow

Create a new workspace spec:

```bash
pnpm exec tsx scripts/polaris.ts create <project>
```

If the project does not already exist, `create` scaffolds:

- `config/specs/docker/projects/<project>.agent.yaml`

Then stage bootstrap secrets and render/start the workspace:

```bash
pnpm exec tsx scripts/polaris.ts render <project>
pnpm exec tsx scripts/polaris.ts start <project>
```

Check health and inspect logs:

```bash
pnpm exec tsx scripts/polaris.ts status <project>
pnpm exec tsx scripts/polaris.ts logs <project>
```

For more operator trace output during lifecycle commands:

```bash
POLARIS_LOG_LEVEL=debug pnpm exec tsx scripts/polaris.ts start <project>
```

If the same project name exists in multiple backend directories, target the
intended one explicitly:

```bash
pnpm exec tsx scripts/polaris.ts status <project>@docker
pnpm exec tsx scripts/polaris.ts logs <project>@kubevirt-vm
```

## Command Model

`create`

- Default onboarding command.
- Scaffolds a Docker saved spec when no workspace config exists yet.
- If a saved spec already exists, dispatches to the configured backend.

`render`

- Loads the saved spec and writes generated output to:
  `config/generated/docker/<project>.yaml` for Docker workspaces.
- Does not start the runtime by itself.

`start`

- Renders first, then runs `docker compose -f config/generated/docker/<project>.yaml up -d`.
- This is the normal way to launch a Docker workspace.

`status`

- Inspects the live backend and synthesizes a control-plane status view.
- Writes a status snapshot to `config/state/<project>.status.json`.
- Reports backend liveness, workspace readiness, daemon readiness, attachment
  checks, runtime assembly checks, and drift.

`logs`

- Tails the backend logs for the workspace runtime.
- For Docker, this is `docker compose ... logs --tail 200 <project>`.

## Secrets And Bootstrap

The default Docker scaffold expects bootstrap material under:

```text
secrets/polaris/
  codex/auth.json
  codex/config.toml
  claude/settings.json
```

At runtime, the Docker backend mounts:

- `./secrets/polaris` by default
- or `$POLARIS_SECRETS_DIR` if that environment variable is set

Those files are copied into the user-scoped identity attachments during
bootstrap:

- `/identity/codex`
- `/identity/claude`

Polaris also creates or assembles:

- workspace data at `/workspace/project`
- workspace runtime state at `/workspace/state/paseo`
- SSH material at `/ssh`
- ephemeral runtime state under `/run/workspace`

When restart issues come from runtime leftovers, clean stale runtime artifacts
only. Do not treat durable state as disposable.

## External Agent Contract

Polaris does not provide a built-in coding harness.

The contract is:

- `Paseo` is the workspace manager/orchestrator layer
- `Codex` and `Claude` are external harnesses bootstrapped into the workspace
- Polaris is responsible for workspace assembly, secrets bootstrap, daemon
  startup, and status/drift reporting
- Harness behavior is external to Polaris

So the default Docker path is:

- Polaris creates the spec
- Polaris renders and starts the workspace
- Paseo comes up inside the workspace
- Codex and Claude use the mounted identity/bootstrap material

## Validation

```bash
pnpm install
pnpm exec tsc -p tsconfig.json --noEmit
pnpm exec tsx scripts/polaris.ts render <project>
pnpm exec tsx scripts/polaris.ts status <project>
```
