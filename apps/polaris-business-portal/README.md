# Polaris Business Portal

This is the Polaris-owned business workspace surface migrated from Wanghai.
It provides product, order, research, SEO, manual-review, and outreach views
over the shared `@polaris/business-core` package.

## Local development

Set `POLARIS_BUSINESS_DATA_ROOT` to a disposable local data root and start the
portal with:

```bash
pnpm --filter @polaris/business-portal run dev
```

The app uses the `/wanghai` mount and signed Wanghai surface envelope for
compatibility with the existing Polaris gateway. The route name is a wire
contract; the implementation and data ownership are Polaris-owned.

Integrated mode must set `POLARIS_BUSINESS_RUNTIME_MODE=polaris`. Filesystem
mutations, review completion, publishing, outreach, and other external effects
remain unavailable until a Polaris durable action supplies admission,
idempotency, quota, audit, and recovery state.

```bash
pnpm --filter @polaris/business-portal run typecheck
pnpm --filter @polaris/business-portal run test
pnpm --filter @polaris/business-portal run build
```
