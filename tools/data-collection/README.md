# clue-data-collection

`clue-data-collection` is the literature / customer-lead / ad-content-intel
collection hub: v2 contracts, three-phase `run` (collection → augmentation →
manual-review), and phase-2 customer-leads commands (`preprocess` /
`augment`).

Agent skill: `Polaris literature collection adapter` (intent → command router).

`run` accepts **`literature`** and **`ad-content-intel`** v2 inputs.
`customer-leads` still uses `preprocess` / `augment` for phase 2.

## Trusted literature sources

| `source_type` | Tool | Notes |
|---------------|------|--------|
| `crossref-search` / `crossref-doi` | `tools/crossref` | Bibliographic search + DOI hydrate (no CAPTCHA) |
| `semantic-scholar-search` | `tools/semantic-scholar` | Optional seed search; primary expand path uses citations/refs |
| `deepsec-search` | `tools/deepsec` | Cybersecurity paper API; pages with `max_results` |
| `curated-web-search` | `tools/web-search` | Optional catalog search |

**Removed:** `tools/google-scholar`, OpenAlex. (`google-scholar-*` tasks are skipped.)

## Ad-content-intel sources (`collection_kind: ad-content-intel`)

| `source_type` | Tool | Notes |
|---------------|------|--------|
| `web-search` | `tools/web-search` | Discovery hits → `social_post` records (`platform: web`) |
| `curated-web-search` | `tools/web-search` + catalog | Same as literature curated path |
| `social_media` | `tools/social-media` | JustOneAPI via `platform-routes.json` (task cache under `POLARIS_LITERATURE_CACHE_ROOT/social-media/`) |

Phase 2 for ad-content-intel attaches `qualification.manual_review_required`
flags only (no PDF/email enrichment yet). Phase 3 uses the same review modes
as literature (`auto-pass` / `auto-approve` / `manual-review`).

**Xiaohongshu:** JustOneAPI route is enabled in
`tools/social-media/config/platform-routes.json` (`platform: xiaohongshu` →
`search_note_v4`, content-note adapter). Docs:
[xiaohongshu-rednote](https://docs.justoneapi.com/zh/api/xiaohongshu-rednote/).
Requires a local JustOneAPI token in `tools/social-media/.env` and the locked
SDK checkout under `tools/social-media/backend/`.

Example seed task:

```json
{
  "task_id": "xhs-keyword",
  "source_type": "social_media",
  "config": {
    "platform": "xiaohongshu",
    "query": "护肤 种草",
    "max_pages": 1
  }
}
```

When candidates exist, normalize maps `platform: xiaohongshu` posts to
`record_kind: xhs_note` (accounts → `xhs_account`).

### Explicit Xiaohongshu single-post capture

The discovery route above intentionally excludes comments, raw provider
payloads, and media. For a public note URL explicitly placed in scope, use the
opt-in deep-capture command instead:

```sh
./clue-data-collection capture-xhs-post \
  --url 'https://xhslink.cn/o/EXAMPLE' \
  --output-dir "$POLARIS_LITERATURE_CACHE_ROOT/xhs-posts/example"
```

It uses the locked JustOneAPI SDK chain:

1. `xiaohongshu.share_url_transfer_v1` — short/share URL → note ID
2. `get_note_detail_v7`, with compatible detail-version fallback — note text,
   metadata, and note-image references
3. `get_note_comment_v4`, with compatible version fallback — all reachable
   top-level comment pages
4. `get_note_sub_comment_v2` — remaining reply pages for each thread

The output directory contains `text.json` (normalized text-only corpus),
`media-manifest.json` (downloaded-image SHA-256 + local reference), and
`capture-report.json` (pagination and coverage evidence). It keeps no raw API
response, user ID, avatar URL, or IP-location field. A `partial` report never
claims that provider pagination or media retrieval was complete.

When only an otherwise-complete reply thread had a transient provider failure,
retry just those gaps without repeating the top-level scan:

```sh
./clue-data-collection capture-xhs-post \
  --repair-output-dir "$POLARIS_LITERATURE_CACHE_ROOT/xhs-posts/example"
```

To turn that cited corpus into a startup-team / investor two-body model:

```sh
./clue-data-collection mine-xhs-knowledge \
  --input "$POLARIS_LITERATURE_CACHE_ROOT/xhs-posts/example/text.json" \
  --output-dir "$POLARIS_LITERATURE_CACHE_ROOT/xhs-posts/example/knowledge"
```

For a cover or comment image that carries readable text, first create an image
review with `tools/image-review`, then pass its `clue.image-review.v1` JSON by
`--image-review`. The miner adds only the reviewed text and its `note.image_ocr`
locator to the corpus; it does not embed image bytes in `text.json`.
For a comment image, use the repeatable
`--comment-image-review COMMENT_ID=review.json` form; its locator is
`comment:COMMENT_ID:image_ocr`.

This writes `knowledge.json`, `simulation-comparison.json`, and
`simulation-monte-carlo.json`. The model is a transparent, educational
simulation rather than investment or legal advice: each derived mechanism is
cited to a captured sentence, and source opinions remain hypotheses.

### Seed scope filter

After source normalize/merge, **seed** literature records are filtered with
`literature_scope` (same rules as expansion):

1. Year window (default last 5 calendar years; override via `scope.time_range`
   like `2022..2026` or `payload.literature_scope.from_year` / `to_year`)
2. CCF A/B/C venue match **or** arXiv CoRR / cs.* preprint when the input
   explicitly enables the venue gate; generic search-plan inputs keep the
   venue gate off unless requested
3. **Topic keywords** on **title + abstract** from Crossref / Semantic Scholar
   payloads (keywords from `scope.include`, or override
   `payload.literature_scope.topic_keywords`)
4. Rejected seeds land in `rejected_records` with `scope_decision.reasons`

Disable only when debugging:

```json
"payload": { "literature_scope": { "enabled": false } }
```

Citation expansion is opt-in for generic search-plan inputs:

```json
"payload": { "citation_expansion": { "enabled": true } }
```

Disable topic filter only (still keep year/venue):

```json
"payload": { "literature_scope": { "topic_filter": false } }
```

### LLM topic-judge criteria (optional)

Keyword OR matching is intentionally loose. For stricter title+abstract
adjudication, put **collection-specific** rules in the input (consumed by
`tools/codex` `topic-judge`; the tool itself is domain-agnostic):

```json
"scope": {
  "include": ["…"],
  "exclude": ["…"],
  "topic_criteria": [
    "Require both X and Y; reject pure Z without X"
  ]
}
```

Preferred for literature collections:

```json
"payload": {
  "literature_scope": {
    "enabled": true,
    "topic_criteria": ["…"]
  }
}
```

Aliases: `judgment_criteria`, `criteria` (top-level, under `scope`, or under
`payload.literature_scope`). Output may record results under
`topic_judgments` (see output v2 schema).

Enable the integrated LLM filter (calls `tools/codex` `topic-judge`):

```json
"payload": {
  "literature_scope": {
    "topic_criteria": ["Require both X and Y"],
    "topic_judge": {
      "enabled": true,
      "stages": ["seed", "expand"],
      "batch_size": 12,
      "cache": true,
      "model": "gpt-5.4-mini"
    }
  }
}
```

- `stages`:
  - `seed` — after year/venue/keyword on phase-1 seeds
  - `expand` — each citation/reference candidate that already passed keyword
    scope is batched through LLM **before** joining corpus/frontier
  - `post_expand` — optional full-corpus pass after expand completes
- Default stages when `topic_criteria` present: `["seed", "expand"]`.
- Judgments cache: `POLARIS_LITERATURE_CACHE_ROOT/topic-judgments/`
  (override `TOPIC_JUDGE_CACHE`).
- Default `enabled` is true when any `topic_criteria` is present.

### Expansion (dual source)

When `payload.citation_expansion.enabled` is not false, expansion walks
**in-scope seed DOIs** and dual-sources:

1. **Semantic Scholar** inbound citations + outbound references
   (fields include `title` + `abstract`)
2. **Crossref** deposited `reference[]` DOIs (hydrated works; JATS abstracts
   stripped to plain text)

Hits are **merged by DOI** (dual-source quality). Missing title/abstract is
hydrated from S2 paper lookup then Crossref before accept. Candidates must
pass year/venue **and** topic keywords on title+abstract; only accepted papers
join the expand frontier. Graph edges: A→B means A references B. Set
`SEMANTIC_SCHOLAR_API_KEY` for batch expand rate limits.

## Literature corpus bounds

Expansion and acceptance use fixed product bounds (see
`literature/scope.py` and `scopes/README.md`):

1. **Time:** last **5** calendar years (e.g. 2022–2026 when run in 2026).
2. **Venue:** CCF recommended international journals/conferences A/B/C
   (`scopes/ccf-recommended-2026.json`, 681 venues).
3. **arXiv CoRR / cs.\* preprints:** allowed even if not on the CCF list.
4. **No count cap:** stop only when no new in-bound papers remain (not a fixed
   N like 180).
5. **Topic:** at least one `scope.include` keyword (or
   `topic_keywords` override) appears in title or abstract.

## Shared PDF cache

Downloaded literature PDFs are stored once under the monorepo:

```text
$POLARIS_LITERATURE_CACHE_ROOT/literature-pdfs/
  by-doi/<prefix>/<rest>.pdf
  by-id/<safe-record-id>.pdf
  manifest.jsonl
```

All workspaces hit this cache before calling Camofox (`pdf_cache_hit`). Override
with `LITERATURE_PDF_CACHE` if needed.

## Install dependencies

```sh
./install-dependencies.sh
```

Runs `clue-data-collection init` (optional email backend for customer-leads
augment) and `tools/browser/clue-browser setup` (Camofox/Playwright for PDF
capture). Requires repo `.env` with `DISPLAY` (e.g.
`:99` under Xvfb), and optional `BROWSER_PROXY_*`. See
[`tools/browser/SETUP-BROWSER.md`](../browser/SETUP-BROWSER.md).

## Contracts

Canonical JSON Schema files live in the **repository root** `schemas/`
only (do not keep a second copy under this tool):

- Input v2: [`schemas/clue.data-collection.input.v2.schema.json`](../../schemas/clue.data-collection.input.v2.schema.json)
- Output v2: [`schemas/clue.data-collection.output.v2.schema.json`](../../schemas/clue.data-collection.output.v2.schema.json)

V2 has stable common fields and a typed `payload`. Supported
`collection_kind` values:

| `collection_kind` | Purpose |
|-------------------|---------|
| `literature` | Papers / literature review pipelines |
| `customer-leads` | B2B lead acquisition (phase-2 preprocess/augment) |
| `ad-content-intel` | Ad & content intelligence (notes, videos, comments, creatives) |

### Record shape (all kinds)

Each `records[]` item requires:

- `record_id`, `record_kind`, `source_url`, `observed_at`, `content_hash`
- `evidence[]` with non-empty `quote` (and optional `locator`)
- `payload` object (kind-specific)

**`record_kind` conventions**

| Kind | Typical `record_kind` |
|------|------------------------|
| literature | paper-like ids (implementation-defined) |
| customer-leads | lead / company oriented |
| ad-content-intel | `xhs_note`, `xhs_video`, `xhs_comment`, `social_post`, `ad_creative`, … |

**`payload` for `ad-content-intel` (optional fields, all in payload)**

- `platform`, `title`, `text`, `author_id`, `author_handle`, `published_at`
- `note_type`: `image` \| `video` \| `other`
- `tags[]`, `engagement` (`likes` / `collects` / `comments` / `shares`)
- `is_ad_like`, `parent_record_id` (comments), optional inlined `comments[]`

Input may set `payload.ad_content_scope` (platforms, queries, include_comments,
include_videos, time_window). Output may include optional top-level
`ad_content_summary`.

### Intermediate artifact schema names

Phase/review helpers use the **`clue.data-collection.*`** prefix only
(former `clue.customer-data-collection.*` ids are gone):

| Role | Schema id |
|------|-----------|
| Main IO | `clue.data-collection.input.v2` / `output.v2` |
| Review list | `clue.data-collection.review-list.v1` |
| Non-review list | `clue.data-collection.non-review.v1` |
| Customer phase result | `clue.data-collection.customer-leads-result.v1` |
| Portal review state/result | `clue.data-collection.review-state.v1` / `review-output.v1` |
| Social candidates | `clue.data-collection.social-media-candidates.v1` |

The editable curated-website registry is `source-catalog.json`. It lets an
input select a topic or named websites without changing either contract.

Polaristool workflow runs write under the `workspaceRoot` Polaristool
passes in the adapter input, typically:

```text
.polaris/workflow-workspaces/<run-id>/collection/data-collections/<collection-id>/
```

The dispatcher derives `<collection-id>` from the validated v2 input and
publishes its normalized output to that collection's `outputs/output.json`.

Only **v2** inputs are accepted (`schema_version: clue.data-collection.input.v2`).
There is no data-collection input/output v1 path.

## Logging

Progress is written as **JSON lines on stderr** (stdout stays the final command
JSON). Tail a run with:

```sh
./clue-data-collection run ... 2> >(tee /tmp/data-collection.log >&2)
# or
./clue-data-collection run ... 2>/tmp/data-collection.log
```

Typical messages: `pipeline_start`, `phase_start` / `phase_done`,
`phase1_task_start` / `phase1_task_done`, `phase2_pdf_capture_start`,
`capture_record_start` / `capture_record_done`, `browser_start` / `browser_done`,
`pipeline_done`.

## Commands

```sh
./clue-data-collection version

# One-time local setup for phase-2 customer-leads email extraction
# (venv + locked kichik/email-scraper under runtime/python).
./clue-data-collection init

./clue-data-collection validate-input \
  --input <input.json>

./clue-data-collection validate-output \
  --output <output.json>

./clue-data-collection list-sources --topic cybersecurity

./clue-data-collection run --input <input.json> --workspace <workspace-id> \
  --run-prefix <run-id-prefix>

# Hold the result for human review:
./clue-data-collection run --input <input.json> --workspace <workspace-id> \
  --run-prefix <run-id-prefix> --review-mode manual-review
```

`validate-input` rejects v2 inputs that omit required identity, scope, source
task, payload, or evidence-trace fields. `validate-output` requires each final
record to retain a stable ID, source URL, observation time, content hash,
quoted evidence, and typed payload.

## Three-phase `run` pipeline

Order is fixed (do not swap 2 and 3):

```text
phase 1 = collection
  source tools + builtin normalize
  optional payload.pdf_links → list URLs only (no download)
  → work/collection-output.json

phase 2 = augmentation   ← not manual-review
  flat modules under tools/data-collection/:
    customer_leads.py  — preprocess | augment | review-list | non-review-results
    website.py         — bounded public HTTP fetch
    pdf_capture.py     — literature PDFs via tools/browser (camofox)
                         record pool default N=8 (PDF_CAPTURE_WORKERS);
                         shared Camofox; per-record URL tries stay serial
  literature + pdf_links → pdf_capture
  literature otherwise   → review-required flags
  customer-leads         → customer_leads preprocess|augment
  → work/augmentation-output.json

phase 3 = manual-review  ← not augmentation
  pipeline.review_mode: auto-pass | auto-approve | manual-review
  default auto-pass: status final, no human queue
  manual-review: pending_manual_review + outputs/manual-review-list.json
  interactive: open manual-review-list.json in the admin portal
  → outputs/output.json
```

| Mode | Flag / input | Phase 3 result |
|------|----------------|----------------|
| Auto-pass | default or `pipeline.review_mode: auto-pass` | `status: final`; review is bypassed |
| Auto-approve | `--review-mode auto-approve` or `pipeline.review_mode: auto-approve` | `status: final`, with automatic approvals and an audit list |
| Manual review | `--review-mode manual-review` or `pipeline.review_mode: manual-review` | `status: pending_manual_review` plus `outputs/manual-review-list.json` |

Optional input:

```json
"pipeline": {
  "review_mode": "auto-pass",
  "skip_augmentation": false
}
```

`skip_augmentation` skips **phase 2 only**. `review_mode` controls **phase 3 only**.

Phase-2 customer commands (same CLI):

```sh
./clue-data-collection preprocess ...
./clue-data-collection augment ...
./clue-data-collection review-list ...
./clue-data-collection non-review-results ...
```


## Tool boundaries

- Customer-lead v1 collection remains owned by the existing map, web-search,
  directory, social-media, augmentation, and portal review workflow.
- Literature collection uses `tools/crossref`, `tools/semantic-scholar`, and
  `tools/deepsec`; later evidence analysis uses
  `tools/intelligence-analysis`.
- `curated-web-search` expands the selected catalog websites into explicit
  `site:` queries and runs the local `tools/web-search` SearXNG adapter. Its
  normalized records are discovery candidates, not verified evidence.
- `deepsec-search` calls `tools/deepsec` for papers from its cybersecurity
  conference index. It preserves the API response as unreviewed literature
  candidates.
- `payload.pdf_links` is an optional literature metadata stage, not a source
  type. It lists source and metadata URLs for PDF acquisition. Phase 1 prefers
  Semantic Scholar `openAccessPdf`, Crossref `link[]` PDFs, and arXiv `/pdf/`
  URLs so phase 2 can short-circuit Camofox when a direct PDF is already known.
  Every candidate remains explicitly unvalidated until downloaded.
- New collection kinds require a schema enum update, checker support, and a
  source adapter before they can be accepted.

## Curated website search

Use `curated-web-search` for topic-oriented searches of maintained websites.
`topic` is required. Omit `source_ids` to search every website in that topic,
or provide IDs returned by `list-sources` to select a subset.

```json
{
  "task_id": "cybersecurity-conferences",
  "source_type": "curated-web-search",
  "config": {
    "topic": "cybersecurity",
    "query": "AI agent permission isolation",
    "source_ids": ["black-hat-usa", "defcon", "chaos-communication-congress"],
    "locale": "en-US"
  }
}
```

The `cybersecurity` topic includes Black Hat and its regional annual archives,
DEF CON, Chaos Communication Congress, YWHack, Phrack, KVM Forum, Kanxue, and
the 360 vulnerability archive. `research-funding` covers the supplied national
and international grant, programme, and enterprise-fund sources. Add future
websites directly to `source-catalog.json` with a stable `source_id`, topic
IDs, domains, and seed URLs.

## DeepSec conference-paper search

Use `deepsec-search` when the collection needs top-security-conference papers.
`keyword` may be Chinese or English. The default search areas are title and
abstract; use `conference`, `year`, `limit`, and `offset` to narrow or paginate.

```json
{
  "task_id": "deepsec-agent-permissions",
  "source_type": "deepsec-search",
  "config": {
    "keyword": "AI agent permission isolation",
    "search_in": ["title", "abstract"],
    "conference": "CCS",
    "year": 2024,
    "limit": 20,
    "offset": 0
  }
}
```

## Candidate PDF links

Set `payload.pdf_links.enabled` for a literature run to add a per-record URL
inventory for manual PDF acquisition:

```json
{
  "payload": {
    "pdf_links": {"enabled": true}
  }
}
```

The collector lists each record's source URL and URL-shaped metadata fields in
`payload.pdf_links.candidates`. A candidate is not an assertion that the target
is a PDF, publicly accessible, or successfully downloaded. It is never passed
to intelligence analysis as document content.

## Verification

```sh
python3 -m unittest discover -s tests -v
```
