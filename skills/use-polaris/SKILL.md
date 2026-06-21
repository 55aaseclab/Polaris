---
name: use-polaris
description: Use when the user wants to create, render, start, inspect, or
  debug a Polaris workspace, especially for the default Docker onboarding
  path, backend targeting, bootstrap secrets, status, or logs.
---

# Use Polaris

Use this skill when the task is operating Polaris itself.

Prefer the Docker backend unless the user asks for `pod` or `kubevirt-vm`.

## Core Flow

The Polaris CLI entrypoint is:

```bash
pnpm exec tsx scripts/polaris.ts
```

For a new Docker workspace:

1. Run `create <project>`.
2. Stage bootstrap secrets under `secrets/polaris/`:
   `codex/auth.json`, `codex/config.toml`,
   `claude/settings.json`.
3. Set `POLARIS_SECRETS_DIR` only when the secrets live elsewhere.
4. Run `render <project>@docker`.
5. Run `start <project>@docker`.
6. Run `status <project>@docker`.
7. Run `logs <project>@docker`.

## Command Model

- `create` scaffolds a saved spec for a new Docker workspace.
- `render` writes generated backend output and does not start the runtime.
- `start` renders first, then launches the backend runtime.
- `status` checks backend liveness, readiness, and drift.
- `logs` tails runtime logs for the selected backend.

If the same project exists in multiple backends, always target
`<project>@<backend>`.

## References

Read `docs/polaris/README.md` when you need:

- the full command model
- runtime assembly details
- secrets bootstrap behavior
- backend-specific operator guidance

Read `docs/README.md` for the documentation entrypoint.

## Guardrails

- Treat saved specs as the source of truth.
- Treat `config/generated/` output as rendered artifacts.
- Do not hand-maintain generated manifests.
- Prefer `status` before deep debugging.
- When restart issues come from leftovers, clean stale runtime artifacts only.
