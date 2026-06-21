# Polaris

`polaris` is now rooted at:

```bash
pnpm exec tsx scripts/polaris.ts
```

## Commands

```bash
pnpm exec tsx scripts/polaris.ts <project>
pnpm exec tsx scripts/polaris.ts render <project>
pnpm exec tsx scripts/polaris.ts status <project>
pnpm exec tsx scripts/polaris.ts reconcile <project>
pnpm exec tsx scripts/polaris.ts create <project>
pnpm exec tsx scripts/polaris.ts start <project>
pnpm exec tsx scripts/polaris.ts stop <project>
pnpm exec tsx scripts/polaris.ts restart <project>
pnpm exec tsx scripts/polaris.ts rebuild <project>
```

## Current Boundary

- `scripts/polaris.ts` is the operator entrypoint and source of truth.
- Backend logic now runs directly through the TypeScript control plane.
- `pod` is currently the most mature backend.
- `kubevirt-vm` and `docker` are being promoted toward first-class runtime-controller backends.

## Validation

```bash
pnpm exec tsc -p tsconfig.json --noEmit
pnpm test:polaris
pnpm exec tsx scripts/polaris.ts status morpheus
pnpm exec tsx scripts/polaris.ts render morpheus
```

## Persistence Semantics

`polaris` now reasons about persistence through attachment classes rather than
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

## Workspace Profiles

Polaris supports explicit workspace profiles.

Today:

- `morpheus` is the built-in reference profile/example

The important distinction is:

- Morpheus remains available as a profile
- backend implementations should no longer depend on the workspace name

## Runtime Controller

Polaris now treats runtime control as a control-plane pipeline:

- backend observation
- drift computation
- status synthesis
- reconcile planning
- backend action execution

`status` and `reconcile` are therefore not thin backend calls anymore; they are
control-plane judgments built from backend observations.
