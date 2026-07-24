# Polaris CLI

This page is the single command reference for Polaris.

Use it instead of repeating CLI syntax across other docs.

## Repo CLI Root

The repo developer CLI entry point is:

```bash
pnpm --dir apps/polaris run polaris -- <command> ...
```

This command does not auto-load `.env.dev`.
Load your env first when you need local development data and services.

## Workspace Commands

Workspace lifecycle and backend control:

```bash
pnpm --dir apps/polaris run polaris -- workspace list --user <userProfileId>
pnpm --dir apps/polaris run polaris -- workspace create <project> --user <userProfileId>
pnpm --dir apps/polaris run polaris -- workspace render <workspaceRef>
pnpm --dir apps/polaris run polaris -- workspace apply <workspaceRef>
pnpm --dir apps/polaris run polaris -- workspace start <workspaceRef>
pnpm --dir apps/polaris run polaris -- workspace stop <workspaceRef>
pnpm --dir apps/polaris run polaris -- workspace restart <workspaceRef>
pnpm --dir apps/polaris run polaris -- workspace rebuild <workspaceRef>
pnpm --dir apps/polaris run polaris -- workspace status <workspaceRef>
pnpm --dir apps/polaris run polaris -- workspace reconcile <workspaceRef>
pnpm --dir apps/polaris run polaris -- workspace logs <workspaceRef>
pnpm --dir apps/polaris run polaris -- workspace switch <project>@<docker|pod|kubevirt-vm>[:driver]
pnpm --dir apps/polaris run polaris -- workspace delete <workspaceRef>
```

`workspace list` returns each saved workspace's raw driver specification files
and raw persisted status record. It never includes credential material.

Runtime credential switching:

```bash
pnpm --dir apps/polaris run polaris -- workspace live-switch <workspaceRef> <credentialId> \
  [--harness <ssh|codex|claude|copilot|opencode|pi>]
```

## User Commands

User list and lifecycle:

```bash
pnpm --dir apps/polaris run polaris -- user list
pnpm --dir apps/polaris run polaris -- user create <userProfileId> \
  [--name <name>] \
  [--email <email>] \
  [--authing <username>] \
  [--authing-user-id <id>] \
  [--referred-by-code <code>] \
  [--role <admin|user>] \
  [--plan <free|pro>]
pnpm --dir apps/polaris run polaris -- user delete <userProfileId>
```

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

## Skill Commands

User skill registry:

```bash
pnpm --dir apps/polaris run polaris -- user skill list <userProfileId>
pnpm --dir apps/polaris run polaris -- user skill add <userProfileId> \
  --source <repo-or-source> --skill <skillName> \
  [--skill-id <skillId>] [--harness <codex|claude>]
pnpm --dir apps/polaris run polaris -- user skill remove <userProfileId> <skillId>
```

Workspace runtime skills:

```bash
pnpm --dir apps/polaris run polaris -- workspace skill-list <workspaceRef> \
  [--user <userProfileId>] [--harness <codex|claude>]
pnpm --dir apps/polaris run polaris -- workspace skill-install <workspaceRef> <skillId> \
  [--user <userProfileId>] [--harness <codex|claude>]
pnpm --dir apps/polaris run polaris -- workspace skill-uninstall <workspaceRef> <skillId> \
  [--user <userProfileId>] [--harness <codex|claude>]
pnpm --dir apps/polaris run polaris -- workspace skill-sync <workspaceRef> \
  [--user <userProfileId>] [--harness <codex|claude>]
```

## Service Commands

Portal and executor:

```bash
pnpm --dir apps/polaris run polaris -- portal [port] [host]
pnpm --dir apps/polaris run polaris -- server [port] [host]
pnpm --dir apps/polaris run polaris -- executor [port] [127.0.0.1]
pnpm --dir apps/polaris run polaris -- ops reconcile-workspaces \
  [--user <userId>] [--workspace <workspace>] \
  [--dry-run] [--refresh-status-only] [--json]
```

`server` and `portal` use the same portal service surface.

## Local Deployment CLI

Repo-only local deployment entry point:

```bash
pnpm --dir apps/polaris run polaris -- local-deploy \
  <install|start|stop|restart|status|open|logs|doctor|upgrade|uninstall|desktop>
```

Installed stage-one local deployment CLI:

```bash
polaris <install|start|stop|restart|status|open|logs|doctor|upgrade|uninstall>
```

The desktop app uses the same local deployment action model.
