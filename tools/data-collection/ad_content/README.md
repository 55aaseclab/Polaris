# Ad-content package (`collection_kind: ad-content-intel`)

Phase map for 广告与内容情报 inside `clue-data-collection run`.
The shared CLI shell stays in `../runner.py`; this package owns ad-content
logic for **1 → 1.5 → 2**. Phase **3** is shared review code in the runner.

External capture tools (not in this package):

- `tools/social-media` — JustOneAPI routes (Xiaohongshu `search_note_v4`, Instagram, …)
- `tools/web-search` — discovery search

## Explicit XHS deep capture (single public URL)

`tools/social-media` is deliberately a shallow discovery tool: its route
policy excludes comments and media. The opt-in command below is separate so a
user-supplied public post can be archived for content research without
changing the discovery boundary:

```sh
../clue-data-collection capture-xhs-post \
  --url 'https://xhslink.cn/o/EXAMPLE' \
  --output-dir "$POLARIS_LITERATURE_CACHE_ROOT/xhs-posts/example"
```

Implementation: `xhs_capture.py`. It uses the locked JustOneAPI SDK under
`tools/social-media/backend/justoneapi-python` and tries these routes in order:

| Need | SDK method | Behavior |
|------|------------|----------|
| Resolve short link | `share_url_transfer_v1` | Extract canonical note ID |
| Note body + media | `get_note_detail_v7` → compatible detail fallback | Retain normalized title/body/engagement and note-image references |
| Top-level comments | `get_note_comment_v4` → `v3`/`v2` fallback | Follow `cursor` until provider terminal state |
| Thread replies | `get_note_sub_comment_v2` | Fetch only when inline replies are incomplete |

Outputs are purposefully narrow:

- `text.json`: title/body, public comment text or provider audio transcript,
  timestamps, counts, thread parent links, and local media IDs.
- `media-manifest.json`: source URL, local relative path, MIME type, bytes,
  SHA-256 and download status for note/comment images.
- `capture-report.json`: expected-versus-captured comment counts and all gaps.

No raw API response, platform user ID, avatar, or IP location is written. A
signed media URL may expire; the manifest keeps its content hash and local
path as the durable reference. Comment images are downloaded whenever a
provider comment field exposes an image URL; if it exposes none, that is called
out in the report rather than assumed absent from the original app view.

For a transient failure in only one reply thread, rerun with
`--repair-output-dir <capture-directory>`. It replays incomplete reply threads
only, deduplicates IDs, and recalculates coverage without re-fetching
top-level comment pages.

### Knowledge mining and executable two-body model

```sh
../clue-data-collection mine-xhs-knowledge \
  --input "$POLARIS_LITERATURE_CACHE_ROOT/xhs-posts/example/text.json" \
  --output-dir "$POLARIS_LITERATURE_CACHE_ROOT/xhs-posts/example/knowledge" \
  --image-review "$POLARIS_LITERATURE_CACHE_ROOT/xhs-posts/example/note-image-review.json"
```

`xhs_knowledge.py` retains every captured sentence as an evidence unit,
classifies source-language concepts, emits cited conditional claims, and maps
them into `startup_investor_simulation.py`. The model contains explicit rules
for evidence/milestones, valuation and dilution, debt and interest, diligence,
policy signals, bargaining power, and founder downside. It rejects unlimited
personal liability by default and labels all source-derived mechanisms as
hypotheses, not facts.

When note or comment imagery itself contains knowledge, use
`tools/image-review/clue-image-review review` on the downloaded local image
first. Passing its `clue.image-review.v1` output via `--image-review` appends
only OCR/visual text with the `note.image_ocr` locator; it never embeds binary
pixels in the text corpus. For a comment image, pass the repeatable
`--comment-image-review COMMENT_ID=review.json` form; it emits a
`comment:COMMENT_ID:image_ocr` locator.

## Pipeline at a glance

```text
1   collection    ad_content/phase1.py (+ runner source dispatch loop)
1.5 expansion     ad_content/phase15.py  (stub / skipped until wired)
2   augmentation  ad_content/phase2.py   (flags now; enrich later)
3   manual-review ../runner.py phase_manual_review  (shared)
```

Entry: `runner.run_three_phase_pipeline` when
`collection_kind == "ad-content-intel"`.

Conceptual map (Discovery → Capture → Normalize → Screen → Enrich):

| Concept | Phase |
|---------|-------|
| Discovery + shallow Capture | **1** (`social_media` / `web-search`) |
| Normalize | **1** (`normalize_*`) |
| Screen | **1** end / **1.5** (not built yet; mirror literature scope/judge) |
| Deep Capture + Enrich | **2** (stub; note detail / comments / author / ads) |
| Human gate | **3** |

---

## Phase 1 — collection

**What:** keyword/platform discovery, shallow capture, normalize to v2
records (`xhs_note`, `social_post`, …).

| Step | Code |
|------|------|
| Allow-list source types | `phase1.AD_CONTENT_SOURCE_TYPES` / `support.SOURCE_TYPES` |
| Dispatch social CLI | `phase1.run_social_media_task` → `tools/social-media/clue-justoneapi-cli batch` |
| Dispatch web search | `phase1.run_web_search_task` → `tools/web-search/clue-web-search-cli batch` |
| Optional curated web | `../runner.py` curated-web-search path (shared with literature) |
| Normalize social candidates | `phase1.normalize_social_media` → `xhs_note` / `xhs_video` / … |
| Normalize web hits | `phase1.normalize_web_search` → `social_post` (platform `web`) |
| Merge | `../runner.py` → `merge_normalized_outputs` |
| Screen | *not yet* (no ad scope/topic-judge) |
| Artifact | `work/collection-output.json` via `runner.phase_collection` |

Xiaohongshu live route: `tools/social-media/config/platform-routes.json`
(`platform: xiaohongshu`). Needs token + locked SDK under social-media.

---

## Phase 1.5 — expansion

**What (planned):** grow seed set without phase-2 deep enrich — e.g. 对标账号
笔记列表、话题/相关笔记. Mirrors literature citation expand.

| Step | Code |
|------|------|
| Orchestration | `phase15.run_expansion` |
| Enable flag | `payload.ad_content_expansion.enabled: true` (default off) |
| Engines | *not wired* — status `skipped` with reason |

When implemented, expect artifacts under
`work/<run>-expand/` similar to literature.

---

## Phase 2 — augmentation

**What (today):**

1. **Media enrich** when the record already has **local** files (see below)
2. Attach `qualification.manual_review_required` for phase 3

**Still planned for the three-phase batch pipeline:** automatic promotion of
discovered posts into this exact-URL deep-capture flow, author enrichment, and
commerce tags. The standalone explicit-URL command above already handles note
detail, comments, reply pagination, and remote image download.

| Step | Code |
|------|------|
| Orchestration | `phase2.run_augmentation` → `media_enrich.enrich_records_with_media` |
| Image / 轮播 | `tools/image-review` |
| Video | `tools/video-review` (audio+ASR; understand via keyframes) |
| Review flags | `phase2.attach_review_qualification` |
| Artifact | `work/augmentation-output.json` |

### Local media on records

Phase 2 looks for existing files on disk (download step not wired yet):

```json
"payload": {
  "note_type": "image",
  "media": {
    "local_paths": ["work/media/note1/1.jpg", "work/media/note1/2.jpg"]
  }
}
```

```json
"payload": {
  "note_type": "video",
  "media": { "local_video": "work/media/note2/clip.mp4" }
}
```

Also accepts `local_images`, `local_video`, `image_path`, `video_path`.

### `payload.ad_content_enrich`

```json
"ad_content_enrich": {
  "enabled": true,
  "dry_run": false,
  "image_review": true,
  "video_review": true,
  "skip_understand": false,
  "max_records": null
}
```

- Default **enabled**; records **without** local media are skipped.
- `dry_run: true` forces image/video tools into dry-run (no Codex/whisper).

---

## Phase 3 — manual-review (shared)

| Step | Code |
|------|------|
| auto-pass / auto-approve / manual-review | `../runner.py` → `phase_manual_review` |
| Portal list | `outputs/manual-review-list.json` when pending |

---

## Package layout

```text
ad_content/
  README.md      ← this file
  __init__.py
  support.py     log / OUTPUT_V2 / AdContentError / SOURCE_TYPES
  phase1.py      normalize + social/web task runners
  phase15.py     expansion stub
  phase2.py      augmentation (+ future enrich)
```

Import as `ad_content.phase1`, … (`tools/data-collection/` on `PYTHONPATH`).

---

## Tests

```sh
cd tools/data-collection
PYTHONPATH=. python3 -m unittest tests.test_runner
```

Ad-specific normalize/augmentation cases live in `tests/test_runner.py`.
Deep-capture and two-body-model tests live in `tests/test_xhs_capture.py`.
