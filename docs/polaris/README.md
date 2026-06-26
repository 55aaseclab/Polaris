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

The Compose helper at `docker-compose.polaris.yml` publishes the self-hosted
Paseo web app on `8082`.

## Default Path

Use `docker` as the clean default onboarding path.

Source of truth and flow:

```text
apps/polaris/scripts/polaris.ts
-> config/users/<user>/projects/<project>/docker.agent.yaml
-> config/users/<user>/projects/<project>/generated/docker.yaml
-> docker compose runtime
```

Polaris owns the saved spec and generated output. Treat generated manifests as
rendered artifacts, not hand-maintained files.

Polaris now treats workspace profile and user profile as separate concerns:

- workspace profile: reusable workspace/runtime defaults
- user profile: Git identity, SSH identity policy, and user-scoped external
  agent identity defaults

Polaris also treats `Credential` as a first-class user-owned entity:

- one user can own multiple credentials
- one workspace can bind multiple credentials by purpose
- driver selection stays separate from credential selection

## Recommended Flow

Create a user first:

```bash
pnpm --dir apps/polaris run polaris -- user create <userProfileId>
```

Then create a workspace spec for that user:

```bash
pnpm --dir apps/polaris run polaris -- create <project> --user <userProfileId>
```

If the user profile does not already exist, `user create` scaffolds:

- `config/users/profiles/<user>.yaml`
- `config/users/<user>/credentials/*.yaml` for default Codex and SSH credentials

If the project does not already exist, `create` scaffolds:

- `config/users/<user>/projects/<project>/docker.agent.yaml`

The scaffolded spec references that local user profile and default bindings:

- `user_profile: <userProfileId>`
- `credentials.bindings[].credentialId: codex-default`

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

`user create`

- Creates a user profile plus default credential registry.

`user delete`

- Removes a user profile, its user-scoped secrets root, and any Clerk username
  mappings that point at that Polaris user.

`create`

- Scaffolds a Docker saved spec when no workspace config exists yet.
- Requires `--user <userProfileId>`.
- Fails if that user profile does not already exist.

`render`

- Loads the saved spec and writes generated output to:
  `config/users/<user>/projects/<project>/generated/docker.yaml`
  for Docker workspaces.
- Does not start the runtime by itself.

`start`

- Renders first, then runs
  `docker compose -f config/users/<user>/projects/<project>/generated/docker.yaml up -d`.
- This is the normal way to launch a Docker workspace.

`status`

- Inspects the live backend and synthesizes a control-plane status view.
- Writes a status snapshot to
  `config/users/<user>/projects/<project>/state/status.json`.
- Reports backend liveness, workspace readiness, daemon readiness, attachment
  checks, runtime assembly checks, and drift.

`logs`

- Tails the backend logs for the workspace runtime.
- For Docker, this is `docker compose ... logs --tail 200 <project>`.

## Credentials And Bootstrap

Credential metadata lives in a pure file-backed registry:

```text
config/users/profiles/<user>.yaml
config/users/<user>/credentials/*.yaml
```

The default Docker scaffold expects secret material under the user-owned
credential root reported by `user create`, for example:

```text
config/users/local-<identity>/
  credentials/
    codex/auth.json
    codex/config.toml
    claude/settings.json
    ssh/id_ed25519
    ssh/id_ed25519.pub
```

Workspace specs bind those credentials by purpose:

```yaml
credentials:
  bindings:
    - purpose: agent-auth
      credentialId: codex-default
      required: true
    - purpose: git-auth
      credentialId: github-ssh
      required: false
```

At runtime, Polaris resolves auth material from explicit credential bindings
first. Legacy `user_profile.auth.files` remains compatibility-only.

The Docker backend mounts:

- `./config/users/<user-profile-id>` by default
- or `$POLARIS_SECRETS_DIR` if that environment variable is set

Those files are copied into the user-scoped identity attachments during
bootstrap:

- `/identity/codex`
- `/identity/claude`

Polaris also creates or assembles:

- workspace data at `/workspace/project`
- workspace manager state at `/workspace/state/paseo`
- workspace evolution state at `/workspace/state/paseo/evolution`
- SSH material at `/ssh`
- ephemeral runtime state under `/run/workspace`

User-scoped identity now belongs to the selected user profile, not only to the
runtime UNIX user or the workspace profile.

When restart issues come from runtime leftovers, clean stale runtime artifacts
only. Do not treat durable state as disposable.

## External Agent Contract

Polaris does not provide a built-in coding harness.

The contract is:

- Polaris targets a manager contract, not a hard-coded daemon product name
- `Paseo` is the first workspace manager/orchestrator adapter
- `Codex` and `Claude` are external harnesses bootstrapped into the workspace
- Polaris is responsible for workspace assembly, secrets bootstrap, daemon
  startup, evolution-state persistence, and status/drift reporting
- Harness behavior is external to Polaris

So the default Docker path is:

- Polaris creates the spec
- Polaris renders and starts the workspace
- Paseo comes up inside the workspace
- Polaris may persist learning artifacts under `/workspace/state/paseo/evolution`
- Codex and Claude use the mounted identity/bootstrap material

## Validation

```bash
pnpm install
pnpm exec tsc -p tsconfig.json --noEmit
pnpm --dir apps/polaris run polaris -- render <project>
pnpm --dir apps/polaris run polaris -- status <project>
```

## More Docs

- [portal-business-flow.md](./portal-business-flow.md)
- [control-plane-maturity.md](./control-plane-maturity.md)
- [isolation-maturity.md](./isolation-maturity.md)
- [agent-swarm-maturity.md](./agent-swarm-maturity.md)
- [evolution-maturity.md](./evolution-maturity.md)
