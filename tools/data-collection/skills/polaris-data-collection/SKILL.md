---
name: polaris-data-collection
description: >
  Map user intent to tools/data-collection (clue-data-collection) commands for
  literature, customer-lead, or ad-content-intel collection, validation,
  phase-2 enrichment, and explicit phase-3 review modes. Use when the user
  wants to collect, validate, or publish workspace collection artifacts.
---

# Polaris data collection

You are a thin router over `tools/data-collection`. **Do not restate the full
tool design.** For contracts, pipeline phases, source types, logging, and
layout, read:

- [`tools/data-collection/README.md`](../../README.md)

Schemas (when editing `input.json` / checking outputs) — **repo root**:

- [`schemas/clue.data-collection.input.v2.schema.json`](../../../../schemas/clue.data-collection.input.v2.schema.json)
- [`schemas/clue.data-collection.output.v2.schema.json`](../../../../schemas/clue.data-collection.output.v2.schema.json)

`collection_kind`: `literature` | `customer-leads` | **`ad-content-intel`**.

For **ad-content-intel** records use content `record_kind` values such as
`xhs_note`, `xhs_video`, `xhs_comment`, `social_post`, `ad_creative`; put title,
text, author, engagement, tags, `is_ad_like`, and optional comments in
`payload` (see README). Workflow template: `ad-content-intel` in
`packs/business/templates.yaml` (first stage is always data-collection).

**`run` supports ad-content-intel** with phase-1 source types `web-search`,
`curated-web-search`, and `social_media`. Xiaohongshu is enabled via
`platform: xiaohongshu` in `tools/social-media` (JustOneAPI `search_note_v4`);
Instagram remains available for business-account discovery.

## Setup (once per machine)

```sh
# Install/update local runtimes (data-collection init + tools/browser setup)
./tools/data-collection/install-dependencies.sh
```

Ensure repo `.env` exists (from `.env.example`), including:

- `DISPLAY=:99` (or another usable X display for Camofox PDF capture)
- `BROWSER_CAMOFOX_USER_ID=polaris` (stable Camofox session)
- `BROWSER_PROXY_*` when PDF sites need a proxy
- `SEMANTIC_SCHOLAR_API_KEY` for batch literature expand

Load env before workspace-aware commands:

```sh
set -a && source .env.dev && set +a
cd tools/data-collection
```

## Your job

1. Parse user intent (validate? list sources? full pipeline? PDF links?
   customer preprocess/augment? review mode?).
2. Ensure a v2 `input.json` (`clue.data-collection.input.v2`).
3. Emit **concrete** `./clue-data-collection …` command lines.
4. Run them when appropriate; report paths and failures from tool JSON.
5. Progress is on **stderr** (JSON lines); final result on **stdout**.

## Intent → commands

| User intent | Command |
|-------------|---------|
| Install deps / email runtime + browser | `./tools/data-collection/install-dependencies.sh` |
| Tool version / phase list | `./clue-data-collection version` |
| Phase-2 email runtime only | `./clue-data-collection init` |
| Validate request | `./clue-data-collection validate-input --input <input.json>` |
| Validate result | `./clue-data-collection validate-output --output <output.json>` |
| List curated sites | `./clue-data-collection list-sources --topic <topic-id>` |
| Full literature or ad-content-intel pipeline | Polaristool `workflow run` via `/settings/tools` / the work desk |
| Choose phase-3 behavior | add `--review-mode auto-pass\|auto-approve\|manual-review` |
| Skip phase-2 only | `"pipeline": {"skip_augmentation": true}` in input |
| Customer-leads preprocess | `./clue-data-collection preprocess --workspace <id> --run-id <run> --source-output type=path …` |
| Customer-leads augment | `./clue-data-collection augment --workspace <id> --run-id <run> --candidates <path>` |
| Rebuild review projections | `review-list` / `non-review-results` |

Interactive phase-3 UI: open `manual-review-list.json` in the admin portal.

## Literature: intent → input + run

1. `collection_kind: "literature"`.
2. Fill `collection_id`, `question`, `decision_context`, `scope`, `evidence_policy`.
3. Map sources to `source_tasks[]` — **prefer** `crossref-search` /
   `crossref-doi`, `deepsec-search`, optional `semantic-scholar-search`.
   Expansion dual-sources Semantic Scholar + Crossref by DOI. Google Scholar
   and OpenAlex are removed.
4. PDF capture in phase 2: `"payload": { "pdf_links": { "enabled": true } }`.
5. Set `pipeline.review_mode` to `auto-pass`, `auto-approve`, or `manual-review`.
6. `validate-input` then `run`.

Submit `AutoResearch` / `LiteratureReview` from the Portal work desk.
Polaristool writes collection output under the run `workspaceRoot`.

## Customer-leads: intent → commands

1. Layout: Polaristool `workspaceRoot` / `acquisition/customer-data-collection/`.
2. Phase 1 sources stay external (`google-map`, `web-search`, …) if new artifacts needed.
3. Phase 2:

```sh
./clue-data-collection preprocess --workspace "$WORKSPACE_ID" --run-id "$PRE" \
  --source-output google_maps="../<maps-run>/results.json" \
  --source-output web_search="../<web-run>/results.json"
./clue-data-collection augment --workspace "$WORKSPACE_ID" --run-id "$AUG" \
  --candidates "../$PRE/preprocessed-candidates.json"
```

4. Phase 3: `manual-review` creates `manual-review-list.json`; open it in the portal.

## Fixed workflows

**Literature** — template `literature-review`:

```text
data-collection → intelligence-analysis → report-writing
```

**Ad / content intel** — `packs/business/templates.yaml`, template
`ad-content-intel`:

```text
data-collection → intelligence-analysis
# collection_kind: ad-content-intel
# analysis_kind: ad-content-review (IA shell; executor empty for now)
```

For literature cases, submit `AutoResearch` / `LiteratureReview` from the
Portal work desk or the workflow API. There is no
`polaris -- literature-review` command.

When a stage has non-empty `steps`, do not bypass with a one-off
`./clue-data-collection run` unless asked. Empty `steps` = reuse prepared
artifacts only.

## Rules

- Prefer real Polaristool workspace paths; never invent evidence.
- Do not invent unsupported `source_type` / `collection_kind`.
- Collection yields **candidates**, not conclusions.
- Prefer the `AutoResearch` / `LiteratureReview` Domain Pack for registered
  literature runs.
- Deep design, flags, catalog, logging → **`tools/data-collection/README.md`**.
