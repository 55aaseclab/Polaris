# Polaris CLI

This page is the command reference for Polaris.

Use it instead of repeating CLI syntax across other docs.

## Repo CLI Root

The repo developer CLI entry point is:

```bash
pnpm --dir apps/polaris run polaris -- <command> ...
```

This command does not auto-load `.env.dev`.
Load your env first when you need local development data and services.

## Terminology

Polaris uses `vault`, not `workspace`, for the runtime object that a user
creates and starts.

Product line is a user subscription field:

- `coding`
- `vertical`
- `both`

Plan is separate and does not choose the line:

- `free`
- `pro`

## Vault Commands

Supported form:

```bash
pnpm --dir apps/polaris run polaris -- vault list --user <userProfileId>
pnpm --dir apps/polaris run polaris -- vault create <projectRef> --user <userProfileId> \
  [--base-image <image>]
pnpm --dir apps/polaris run polaris -- vault apply <vaultRef> [--user <userProfileId>]
pnpm --dir apps/polaris run polaris -- vault render <vaultRef> [--user <userProfileId>]
pnpm --dir apps/polaris run polaris -- vault start <vaultRef> [--user <userProfileId>]
pnpm --dir apps/polaris run polaris -- vault stop <vaultRef> [--user <userProfileId>]
pnpm --dir apps/polaris run polaris -- vault restart <vaultRef> [--user <userProfileId>]
pnpm --dir apps/polaris run polaris -- vault rebuild <vaultRef> [--user <userProfileId>]
pnpm --dir apps/polaris run polaris -- vault status <vaultRef> [--user <userProfileId>]
pnpm --dir apps/polaris run polaris -- vault reconcile <vaultRef> [--user <userProfileId>]
pnpm --dir apps/polaris run polaris -- vault logs <vaultRef> [--user <userProfileId>]
pnpm --dir apps/polaris run polaris -- vault live-switch <vaultRef> <credentialId> \
  [--harness <ssh|codex|claude|copilot|opencode|pi>]
pnpm --dir apps/polaris run polaris -- vault switch <vaultRef>
pnpm --dir apps/polaris run polaris -- vault delete <vaultRef> [--user <userProfileId>]
pnpm --dir apps/polaris run polaris -- vault skill-list <vaultRef> \
  [--user <userProfileId>] [--harness <codex|claude>]
pnpm --dir apps/polaris run polaris -- vault skill-install <vaultRef> <skillId> \
  [--user <userProfileId>] [--harness <codex|claude>]
pnpm --dir apps/polaris run polaris -- vault skill-uninstall <vaultRef> <skillId> \
  [--user <userProfileId>] [--harness <codex|claude>]
pnpm --dir apps/polaris run polaris -- vault skill-sync <vaultRef> \
  [--user <userProfileId>] [--harness <codex|claude>]
```

`vault list` returns each saved vault's raw driver spec files and raw persisted
status record. It never includes credential material.

`vault create` scaffolds a new vault when missing. `--base-image` only applies
while scaffolding a new vault.

Vault references are parsed as:

- `<project>`
- `<project>@docker`
- `<project>@pod`
- `<project>@pod:<profile>`
- `<project>@kubevirt-vm`

## Domain Pack Commands

Domain Packs are Polaris control-plane objects. They are stored outside every
Vault under `$POLARIS_DATA_ROOT/control/domain-packs/<domain>/<version>/`.
Each installation contains the [Polaris DSL](./dsl.md) source and a SHA-256
manifest. Language, import, and validation rules live on that page.

```bash
pnpm --dir apps/polaris run polaris -- pack add <file.ord|pack-directory>
pnpm --dir apps/polaris run polaris -- pack list
pnpm --dir apps/polaris run polaris -- pack remove <domain> \
  [--version <x.y.z>]
```

`pack add` validates the source and its already-installed imports before the
atomic install. `pack list` reports `verified` or `drifted` source integrity.
When more than one version is installed, `pack remove` requires
`--version`; it never removes Vault data.

## User Commands

```bash
pnpm --dir apps/polaris run polaris -- user list
pnpm --dir apps/polaris run polaris -- user create <userProfileId> \
  [--name <name>] \
  [--email <email>] \
  [--authing <username>] \
  [--authing-user-id <id>] \
  [--referred-by-code <code>] \
  [--role <admin|user>] \
  [--plan <free|pro>] \
  [--line <coding|vertical|both>]
pnpm --dir apps/polaris run polaris -- user update <userProfileId> \
  [--name <name>] \
  [--email <email>] \
  [--github-account <account>] \
  [--ssh-comment <comment>] \
  [--role <admin|user>] \
  [--plan <free|pro>] \
  [--line <coding|vertical|both>]
pnpm --dir apps/polaris run polaris -- user defaults read <userProfileId>
pnpm --dir apps/polaris run polaris -- user defaults set <userProfileId>
pnpm --dir apps/polaris run polaris -- user delete <userProfileId>
```

`user defaults set` is currently disabled.
Polaris no longer stores a user default docker base image there.

## User Credential Commands

```bash
pnpm --dir apps/polaris run polaris -- user credential add <userProfileId> \
  --harness <ssh|codex|claude|copilot|opencode|pi> \
  [--credential-id <id>] \
  [--label <label>] \
  [--provider-name <name>] \
  [--base-url <url>] \
  [--api-key <key>] \
  [--preset-id <id>] \
  [--model <name>] \
  [--activate]
pnpm --dir apps/polaris run polaris -- user credential create <userProfileId> ...
pnpm --dir apps/polaris run polaris -- user credential list <userProfileId>
pnpm --dir apps/polaris run polaris -- user credential read <userProfileId> <credentialId>
pnpm --dir apps/polaris run polaris -- user credential write <userProfileId> <credentialId> \
  <fileKey> --content <value>
pnpm --dir apps/polaris run polaris -- user credential activate <userProfileId> <credentialId>
pnpm --dir apps/polaris run polaris -- user credential delete <userProfileId> <credentialId>
```

## User Skill Commands

```bash
pnpm --dir apps/polaris run polaris -- user skill list <userProfileId>
pnpm --dir apps/polaris run polaris -- user skill add <userProfileId> \
  --source <repo-or-source> --skill <skillName> \
  [--skill-id <skillId>] [--harness <codex|claude>]
pnpm --dir apps/polaris run polaris -- user skill remove <userProfileId> <skillId>
```

## Service Commands

`portal` and `server` are aliases for the same Polaris service:

```bash
pnpm --dir apps/polaris run polaris -- portal [port] [host]
pnpm --dir apps/polaris run polaris -- server [port] [host]
```

There is no separate executor process. Vault lifecycle and durable-job work run
in the same `polaris-server` process.

## Operator Commands

```bash
pnpm --dir apps/polaris run polaris -- ops reconcile-vaults \
  [--user <userId>] [--vault <vault>] \
  [--dry-run] [--refresh-status-only] [--json]

pnpm --dir apps/polaris run polaris -- ops audit \
  [--limit <1-1000>] [--verify] [--json]
```

`ops audit` is a host-operator command. It lists a redacted audit envelope and
never prints stored metadata. `--verify` checks the local durable hash chain
and exits nonzero when a link or event hash is invalid. It does not establish
off-host retention or detect all database truncation; treat those as separate
release requirements.
