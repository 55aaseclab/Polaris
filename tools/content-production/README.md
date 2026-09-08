# polaris-content-production

Unified content production tool. **`product-catalog` is a content kind**, not a
separate package.

```text
wanghai.content-production.input.v1 (legacy contract)
  → phases: validate → select → freeze → plan → produce → package → review → publish
  → wanghai.content-production.output.v1 (legacy contract)
```

| `content_kind` | Status |
|----------------|--------|
| `product-catalog` | Implemented (HTML → PDF) |
| `carousel` | Schema + skill only |
| `video` | Prefer `tools/product-video` until folded in |

Legacy `wanghai.promo.catalog-input` files are still accepted by `run`.

## Contracts

- `schemas/wanghai.content-production.input.v1.schema.json`
- `schemas/wanghai.content-production.output.v1.schema.json`
- Internal catalog projection: `wanghai.promo.catalog-{input,snapshot,output}`

## Layout

```text
# product-catalog kind (gallery workflow compat)
产品管理/交付归档/catalogs/<job_id>/

# other kinds (future)
产品管理/交付归档/content-production/<job_id>/
```

## Commands

```bash
pnpm content-production version

pnpm content-production init-input \
  --workspace-root /path/to/workspace \
  --job-id demo-ch-2026q3 \
  --product-ids 12,15,43 \
  --market CH --locale en

pnpm content-production run \
  --workspace-root /path/to/workspace \
  --input 产品管理/交付归档/catalogs/demo-ch-2026q3/inputs/input.json

pnpm content-production run ... --skip-pdf
pnpm content-production run ... --strict
```

Wrapper:

```bash
./tools/content-production/polaris-content-production run \
  --workspace-root … --input …
```

## Tests

```bash
pnpm --filter @polaris/content-production test
pnpm --filter @polaris/content-production typecheck
```
