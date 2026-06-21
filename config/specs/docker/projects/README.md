Docker workspace specs live here in the target Polaris layout.

Use this directory as the clean default onboarding path:

```text
apps/polaris/scripts/polaris.ts
-> config/specs/docker/projects/<project>.agent.yaml
-> config/generated/docker/<project>.yaml
-> docker compose runtime
```

Recommended lifecycle:

```bash
pnpm --dir apps/polaris run polaris -- create <project>
pnpm --dir apps/polaris run polaris -- render <project>
pnpm --dir apps/polaris run polaris -- start <project>
pnpm --dir apps/polaris run polaris -- status <project>
pnpm --dir apps/polaris run polaris -- logs <project>
```

Notes:

- `create` scaffolds a Docker spec here when no workspace config exists yet.
- `render` regenerates `config/generated/docker/<project>.yaml`.
- `start` runs the rendered Docker Compose workspace.
- `status` inspects the live runtime and writes `config/state/<project>.status.json`.
- `logs` tails the workspace runtime logs.
- Bootstrap secrets are expected under `config/users/100000000000000001/` unless
  `$POLARIS_SECRETS_DIR` overrides the mount source.

During the migration, old Docker runtime material may still exist, but the
TypeScript control plane remains the source of truth. Do not hand-maintain the
generated manifest as the final fix.
