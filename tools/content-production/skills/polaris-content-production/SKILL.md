---
name: polaris-content-production
description: >
  Map user intent to content-production jobs (product-catalog, carousel,
  video): validate input, run phases, and publish auditable deliverables from
  ready product meta. Use when the user wants product catalogs, social
  carousels, or short product videos.
---

# Polaris content production

Thin router over **`tools/content-production`** (`@polaris/content-production`).
There is no separate product-catalog package; catalog is the
`content_kind: product-catalog` mode of this tool.

**Do not invent product facts.** Only ready product `meta.json` + image slots.
Costs never enter deliverables.

## Contracts (repo root)

- [`schemas/wanghai.content-production.input.v1.schema.json`](../../../../schemas/wanghai.content-production.input.v1.schema.json)
- [`schemas/wanghai.content-production.output.v1.schema.json`](../../../../schemas/wanghai.content-production.output.v1.schema.json)

Internal catalog projection (freeze/render only):

- [`schemas/wanghai.promo.catalog-input.v1.schema.json`](../../../../schemas/wanghai.promo.catalog-input.v1.schema.json)
- [`schemas/wanghai.promo.catalog-snapshot.v1.schema.json`](../../../../schemas/wanghai.promo.catalog-snapshot.v1.schema.json)
- [`schemas/wanghai.promo.catalog-output.v1.schema.json`](../../../../schemas/wanghai.promo.catalog-output.v1.schema.json)

Tool README: [`tools/content-production/README.md`](../../README.md)

`content_kind`: **`product-catalog`** | **`carousel`** | **`video`**.

| Kind | Tool status |
|------|-------------|
| product-catalog | Implemented in `tools/content-production` |
| carousel | Schema + phases only |
| video | `tools/product-video` — local kenburns **or** JieKou **Seedance 1.5 Pro** (`provider: jiekou`, flex/480p/no-audio). STT: `tools/video-review transcribe` → **ElevenLabs Scribe v2** via `JIEKOU_API_KEY`. |

## Your job

1. Parse intent → choose `content_kind`.
2. Ensure a v1 `input.json` (`wanghai.content-production.input.v1`).
3. Run `./tools/content-production/polaris-content-production …`.
4. Report artifact paths and phase failures.
5. Never put `pricing.costs` or order data into content.

## Workspace layout

```text
$POLARIS_BUSINESS_WORKSPACES_ROOT/<workspace>/产品管理/交付归档/catalogs/<job_id>/   # product-catalog
$POLARIS_BUSINESS_WORKSPACES_ROOT/<workspace>/产品管理/交付归档/content-production/<job_id>/  # future kinds
  inputs/input.json
  work/
  runs/
  outputs/output.json   # umbrella output for content-production input
```

## Shared phases

```text
validate → select → freeze → plan → produce → package → review → publish
```

Details: [`references/phases.md`](references/phases.md).

## Commands

```sh
set -a && source .env.dev && set +a

./tools/content-production/polaris-content-production init-input \
  --workspace-root "$WS" \
  --job-id "$JOB_ID" \
  --product-ids 12,15,43 \
  --market CH --locale en

./tools/content-production/polaris-content-production run \
  --workspace-root "$WS" \
  --input "产品管理/交付归档/catalogs/$JOB_ID/inputs/input.json"

# HTML only
./tools/content-production/polaris-content-production run ... --skip-pdf

# Fail on any skipped SKU
./tools/content-production/polaris-content-production run ... --strict
```

Fixed gallery workflow (`packs/business/templates.yaml` template `product-gallery`):

Use the business portal's `product-gallery` template. Any write or external
publish must be submitted through a Polaris durable action; the local tool is
for validation and explicitly admitted local runs only.

## Intent → actions

| User intent | Action |
|-------------|--------|
| 出图册 / catalog PDF | `content_kind=product-catalog` → `polaris-content-production run` |
| 小红书轮播 | `content_kind=carousel` → write input + plan; no package yet |
| 短视频 | Prefer `tools/product-video` **or** write content-production video input for later |
| 只要 HTML | `pipeline.skip_package: true` / `--skip-pdf` |
| 全部外发 SKU | `product_selection.mode=external` |

## Rules

1. Ready pool first — no invented copy/images.
2. One kind per job.
3. Deterministic price/spec text for customer-facing assets.
4. Prefer real paths under `POLARIS_BUSINESS_WORKSPACES_ROOT`.
5. Implementation details → `tools/content-production/README.md`.
