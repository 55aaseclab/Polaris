# agentctl

`agentctl` is now rooted at:

```bash
pnpm exec tsx scripts/agentctl.ts
```

## Commands

```bash
pnpm exec tsx scripts/agentctl.ts <project>
pnpm exec tsx scripts/agentctl.ts render <project>
pnpm exec tsx scripts/agentctl.ts status <project>
pnpm exec tsx scripts/agentctl.ts reconcile <project>
pnpm exec tsx scripts/agentctl.ts create <project>
pnpm exec tsx scripts/agentctl.ts start <project>
pnpm exec tsx scripts/agentctl.ts stop <project>
pnpm exec tsx scripts/agentctl.ts restart <project>
pnpm exec tsx scripts/agentctl.ts rebuild <project>
```

## Current Boundary

- `scripts/agentctl.ts` is the operator entrypoint and source of truth.
- Backend logic now runs directly through the TypeScript control plane.
- `docker` is still intentionally preserved as a legacy backend boundary rather
  than fully reworked.

## Validation

```bash
pnpm exec tsc -p tsconfig.json --noEmit
pnpm test:agentctl
pnpm exec tsx scripts/agentctl.ts status morpheus
pnpm exec tsx scripts/agentctl.ts render morpheus
```

## Persistence Semantics

`agentctl` now reasons about persistence through attachment classes rather than
through a persisted runtime home:

- `workspace-data`
- `workspace-runtime-state`
- `user-identity-state`
- `user-ssh-state`
- `ephemeral-runtime`

See [runtime-layout.md](./runtime-layout.md) for the backend-independent model.

## Direct Config Model

The primary saved-spec model is now attachment-based:

- `workspace-data`
- `workspace-runtime-state`
- `user-identity-state`
- `user-ssh-state`
- `ephemeral-runtime`

Legacy path-centric persistence fields remain compatibility-only and are
translated only when direct attachment declarations are absent.
