---
name: use-polaris
description: Use when the user wants to create, render, start, inspect, or
  debug a Polaris workspace, especially for backend targeting, image
  preparation, status, or logs.
---

# Use Polaris

Use this skill when the task is operating Polaris itself.

Prefer the Docker backend unless the user asks for `pod` or `kubevirt-vm`.

## Phases

The Polaris CLI entrypoint is:

```bash
pnpm --dir apps/polaris run polaris --
```

### Phase 1: Create User

1. Run `create <project>`.
2. If the referenced user profile does not exist yet, let Polaris create it
   first.
3. Expect Polaris to create the user profile and the default credential
   registry together.
4. Confirm the saved spec points at the intended `user_profile`.
5. Confirm the saved spec also contains the default credential bindings.

### Phase 2: Prepare Image

For `docker` and `pod`:

1. Ensure the workspace `base_image` exists and is the image you intend to run.

For `kubevirt-vm`:

1. Ensure the workspace `base_image` exists.
2. Build or refresh the guest `rootdisk_image`.
3. Update the saved spec so `rootdisk_image` points at the new tag.

### Phase 3: Start

For `docker` and `pod`:

1. Run `render <project>@<backend>`.
2. Run `start <project>@<backend>`.
3. Run `status <project>@<backend>`.
4. Run `logs <project>@<backend>` when needed.

For `kubevirt-vm`:

1. Run `render <project>@kubevirt-vm`.
2. Run `apply <project>@kubevirt-vm`.
3. Run `start <project>@kubevirt-vm` or `restart <project>@kubevirt-vm`.
4. Run `status <project>@kubevirt-vm`.
5. Run `logs <project>@kubevirt-vm` when needed.

The required order is:

1. Create user
2. Prepare image(s)
3. Start

## Command Model

- `create` scaffolds a saved spec for a new Docker workspace.
- `create` also provisions a local user profile when the scaffolded spec would
  otherwise point at a missing profile.
- `create` also provisions default user credentials at
  `config/users/credentials/<user>/`.
- The default credential set is:
  - `codex-default`
  - `github-ssh`
- The scaffolded workspace should bind those credentials by purpose instead of
  relying only on legacy inline auth fields.
- `render` writes generated backend output and does not start the runtime.
- `apply` applies rendered backend output without implying runtime health.
- `start` should be treated as runtime launch only after image preparation is complete.
- `status` checks backend liveness, readiness, and drift.
- `logs` tails runtime logs for the selected backend.

For KubeVirt image work:

- Use `scripts/operations/build-kubevirt-rootdisk-image.sh <rootdisk-ref>`.
- The rootdisk build is guest-state aware and is the authoritative way to
  refresh the KubeVirt guest image.
- KubeVirt requires two images in practice:
  - `base_image`
  - `rootdisk_image`

If the same project exists in multiple backends, always target
`<project>@<backend>`.

## References

Read `docs/polaris/README.md` when you need:

- the full command model
- runtime assembly details
- image preparation behavior
- backend-specific operator guidance

Read `docs/README.md` for the documentation entrypoint.

## Guardrails

- Treat saved specs as the source of truth.
- Treat `config/generated/` output as rendered artifacts.
- Do not hand-maintain generated manifests.
- Do not bypass the four attachment protocol with ad hoc bind mounts.
- Do not start a backend before its required image set is ready.
- Prefer `status` before deep debugging.
- When restart issues come from leftovers, clean stale runtime artifacts only.
