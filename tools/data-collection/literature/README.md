# Literature package (`collection_kind: literature`)

Phase map for the literature path inside `clue-data-collection run`.
The shared CLI shell stays in `../runner.py`; this package owns literature
logic for **1 → 1.5 → 2**. Phase **3** is shared review code in the runner.

Do not confuse this with the separate product tool
`tools/intelligence-analysis/literature-review/` (internal IA/RW orchestration).

## Pipeline at a glance

```text
1   collection   literature/phase1.py (+ runner source dispatch)
1.5 expansion    literature/phase15.py → expand.py, scope, topic_judge
2   augmentation literature/phase2.py  → pdf_capture, pdf_cache
3   manual-review  ../runner.py phase_manual_review  (shared)
```

Entry: `runner.run_three_phase_pipeline` when
`collection_kind == "literature"`.

---

## Phase 1 — collection

**What:** discover seeds, normalize to v2 records, screen, optionally list
PDF URLs (no download).

| Step | Code |
|------|------|
| Dispatch source CLIs | `../runner.py` → `run_phase1_sources` (crossref, S2, deepsec, curated-web-search, …) |
| Normalize Crossref / S2 / DeepSec | `phase1.normalize_crossref` / `normalize_semantic_scholar` / `normalize_deepsec` |
| Merge multi-source outputs | `../runner.py` → `merge_normalized_outputs` |
| Seed screen (year / optional CCF·arXiv / topic keywords) | `phase1.apply_seed_literature_scope` → `scope.filter_records` |
| Optional LLM topic-judge (`stage=seed`) | `topic_judge.apply_topic_judge` (from `runner.phase_collection`) |
| List PDF candidate URLs only | `phase1.collect_paper_links` → `record_candidate_links` → `pdf_capture.provider_pdf_candidates` |
| Write intermediate | `runner.phase_collection` → `work/collection-output.json` |

Supporting modules: `scope.py` (bounds + CCF catalog under `../scopes/`),
`topic_judge.py`.

---

## Phase 1.5 — expansion

**What:** grow the corpus via citations/references; re-screen each
candidate. **Not** phase 2. Main driver of record count.

| Step | Code |
|------|------|
| Orchestration | `phase15.run_expansion` |
| Dual-source expand loop | `expand.expand_collection` |
| Graph edges / DOT | `graph.LiteratureGraph` |
| Bounds + venue + topic keywords | `scope.bounds_from_input`, `evaluate_record`, … |
| Expand-time LLM batches | `topic_judge.ExpandTopicJudgeBuffer` (inside expand) |
| Optional post-expand judge | `topic_judge.apply_topic_judge(stage="post_expand")` |
| Re-list PDF URLs after grow | `phase1.collect_paper_links` (if `payload.pdf_links` set) |
| Artifacts | `work/<run>-expand/expanded-collection.json`, `expand-state.json`, graph DOT |

Skip: `payload.citation_expansion.enabled: false`.
Resume: empty `frontier` in `expand-state.json` → runner skips re-expand.

---

## Phase 2 — augmentation

**What:** deep fetch (PDF) + qualification flags for review. Does not grow
the DOI set.

| Step | Code |
|------|------|
| Orchestration | `phase2.run_augmentation` |
| Ensure link inventory | `phase1.collect_paper_links` if needed |
| Download PDFs | `pdf_capture.capture_pdfs_for_collection` → `tools/browser` |
| Shared PDF disk cache | `pdf_cache` (`POLARIS_LITERATURE_CACHE_ROOT/literature-pdfs/`) |
| Mark review-required | `phase2.attach_review_qualification` |
| Artifact | `work/augmentation-output.json` |

Enable downloads with `payload.pdf_links: { "enabled": true }`.

---

## Phase 3 — manual-review (shared)

**What:** human gate only; no literature-specific enrich.

| Step | Code |
|------|------|
| Modes auto-pass / auto-approve / manual-review | `../runner.py` → `phase_manual_review` |
| Portal list | `outputs/manual-review-list.json` when pending |

---

## Package layout

```text
literature/
  README.md           ← this file
  __init__.py
  support.py          shared log / OUTPUT_V2 / LiteratureError
  phase1.py           collection helpers
  phase15.py          expansion orchestration
  phase2.py           PDF augmentation orchestration
  expand.py           citation expand engine
  scope.py            corpus bounds + CCF matching
  graph.py            reference/citation graph
  topic_judge.py      tools/codex topic-judge integration
  pdf_capture.py      Camofox/browser PDF retrieval
  pdf_cache.py        shared on-disk PDF cache
```

Import as `literature.phase1`, `literature.expand`, `literature.pdf_capture`,
etc. (package root is `tools/data-collection/` on `PYTHONPATH` / cwd).

---

## Tests

```sh
cd tools/data-collection
PYTHONPATH=. python3 -m unittest \
  tests.test_runner \
  tests.test_literature_expand \
  tests.test_literature_topic_judge
```
