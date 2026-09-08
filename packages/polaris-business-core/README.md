# Polaris Business Core

`@polaris/business-core` is the shared library for Polaris business tools.
It owns workspace-safe paths, product and order records, document rendering,
SEO operations, manual-review state, and the local business data boundary.

The package is independent of the Wanghai repository. Existing workspace
documents keep their `wanghai.*` schema identifiers where compatibility is
required; those identifiers are legacy data contracts and are validated from
Polaris's root `schemas/` directory.

## Runtime boundary

Standalone local preparation uses `POLARIS_BUSINESS_DATA_ROOT`, from which the
workspace, backup, and cache directories are derived. Integrated execution
uses the fixed private mounts `/vault/workspaces`, `/vault/backups`, and
`/vault/cache`.

Business tools fail closed in integrated mode. Polaris must supply the durable
permission, idempotency, outbox, audit, quota, and recovery boundary before a
write or external side effect is enabled.

## Checks

```bash
pnpm --filter @polaris/business-core run typecheck
pnpm --filter @polaris/business-core run test
```
