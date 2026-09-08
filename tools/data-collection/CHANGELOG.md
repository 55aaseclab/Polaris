# Changelog

## Unreleased

- Added explicit `capture-xhs-post` for a user-supplied public Xiaohongshu URL.
  It resolves short links with JustOneAPI, falls back across compatible note and
  comment endpoints, paginates comments/replies, downloads exposed note/comment
  images with SHA-256 references, and writes a normalized text-only corpus.
  It never writes raw provider payloads, profile IDs, avatar URLs, or IP data.
- Added `mine-xhs-knowledge` plus a cited startup-team / investor two-body
  simulation. It preserves every source sentence, distinguishes social claims
  from conditional model rules, compares equity/debt timing strategies, and
  emits seeded Monte Carlo runs.

- `allow_arxiv_corr: false` excludes the **arXiv + CoRR unit** at evaluate time
  (including when `venue_filter` is off). Detection uses host/DOI/venue labels,
  not abstract text that merely cites arXiv.
- Removed data-collection **v1 / legacy** input acceptance and the
  `import-legacy-customer` / `upgrade-imported-customer` commands
  (`legacy_customer_import.py` deleted). Main IO is **v2 only**.

- Moved input/output **v2** JSON Schema to repository root `schemas/`.
- Removed leftover `tools/data-collection/schemas/` pointer directory.
- Extended `collection_kind` with **`ad-content-intel`** (optional
  `payload.ad_content_scope`; content `record_kind` / payload fields).
- Renamed intermediate customer artifact schema ids to
  `clue.data-collection.*` (drop `customer-data-collection` prefix).

- **Resume fix:** finished citation expand (`expand-state.json` frontier `[]`)
  no longer reopens every corpus DOI on restart; pipeline skips seed re-fetch
  + re-expand and continues at PDF capture (`pipeline_resume_from_expand`).
  PDF capture already skips `pdf_on_disk` / cache hits.
- Allow opting out of the strict CCF venue gate via
  `payload.literature_scope.venue_filter: false` (or `require_ccf_venue: false`).
  Year bounds and LLM topic-judge still apply when enabled.
- Integrate `tools/codex` topic-judge into the literature pipeline
  (`literature_topic_judge.py`): seed, **expand-time** (keyword-pass
  candidates batched before corpus/frontier), and optional post-expand;
  disk cache under `POLARIS_LITERATURE_CACHE_ROOT/topic-judgments/`; config via
  `payload.literature_scope.topic_judge` (default stages `seed`+`expand`).
- Semantic Scholar `cache_stats()` (hits/misses/puts) logged on expand items.
- Input/output v2 schemas document literature `scope.include` / `exclude`,
  `topic_criteria` (and aliases), and `payload.literature_scope` fields;
  optional output `topic_judgments` for `tools/codex` topic-judge results.
- Topic filter on **title + abstract** using keywords from `scope.include`
  (or `payload.literature_scope.topic_keywords`) for seed + expand. Only
  in-topic papers join the expand frontier.
- Semantic Scholar citation/reference fields now request `abstract` (was
  title-only). Expand hydrates missing abstract via S2 paper then Crossref;
  Crossref JATS abstracts stripped to plain text.
- Phase-1 **seed** records are filtered with `literature_scope` (CCF A/B/C,
  year window, arXiv CoRR, topic) before expand; rejections go to
  `rejected_records` with `scope_decision`. Shared `bounds_from_input()` for
  seed + expand.
- Expose provider PDF URLs to phase 2: Semantic Scholar `openAccessPdf`,
  Crossref `link[]` PDF endpoints, and arXiv `/pdf/{id}` from `externalIds`,
  listed first in `pdf_links.candidates` and preferred by `pdf_capture` scoring.
- Fix Semantic Scholar expand import shadowing `data-collection/runner.py`.
- Stronger S2 429 backoff; Crossref DOI fetch tries case variants.
- Map PACMSE / Proceedings of the ACM on Software Engineering → FSE
  (`conf/sigsoft`), not crypto Fast Software Encryption.

## 0.5.0 - 2026-07-22

- **Crossref restored** (`crossref-doi`, `crossref-search`) as seed discovery.
- **Semantic Scholar** tool added; expansion dual-sources S2 citations/refs +
  Crossref reference DOIs, merge-by-DOI for quality.
- **Google Scholar removed** (`tools/google-scholar` deleted; tasks skipped).
- DeepSec remains for cybersecurity seeds (`max_results` paging).
- OpenAlex stays removed (noisy `referenced_works`).

## 0.4.0 - 2026-07-22

- Phase 2 literature `pdf_capture` uses a record-level worker pool (default
  **N=8**, env `PDF_CAPTURE_WORKERS`) against a shared long-lived Camofox
  server so concurrent clue-browser runs do not start/kill the browser per URL.
  Candidate URLs within a record stay serial.
- `pdf_capture` filters junk/wrong candidate URLs before browser work: ACM PDF
  links only for ACM DOIs (`10.1145`/`10.5455`), drop crossmark/policy/ORCID/
  ROR/Creative Commons and non-PDF OpenAlex CDN noise. Logs
  `capture_candidates_filtered`.
- `run` is a three-phase pipeline: collection → augmentation → manual-review.
- Merged the full former `tools/augmentation` runner into this package as
  **phase 2** flat modules: `customer_leads.py`, `website.py`, `pdf_capture.py`
  (no separate tools/augmentation package).
- Added `init` to prepare the phase-2 email-extractor runtime (replaces
  `build-email-backend` / `backend-status`).
- Added `install-dependencies.sh` (init + tools/browser setup) and stderr JSON
  progress logging for `run`.
- `--auto-approve` (or `pipeline.auto_approve`) skips phase 3 human gate.
- Without auto-approve, writes `manual-review-list.json` and
  `non-review-results.json` and sets status `pending_manual_review`.
- Kept Crossref normalization as a builtin of collection only; removed the
  public `normalize-crossref` CLI subcommand.

## 0.3.0 - 2026-07-21

- Added optional literature `payload.pdf_links` inventories for manual PDF
  acquisition. Candidates are source metadata, not download results.
- Removed automated paper-file acquisition paths. The collector does not browse,
  validate, or store paper files.

## 0.2.0 — 2026-07-20

- Added an editable curated-website source catalog, initially with a
  `cybersecurity` topic and a `research-funding` topic.
- Added `list-sources` for discovering catalog topics and source IDs.
- Added `curated-web-search`, which expands selected catalog websites into
  auditable `site:` searches through the existing local SearXNG tool.
- Normalized curated website results as unreviewed `web-candidate` records.
- Added `deepsec-search` to normalize cybersecurity conference-paper results
  from the Intelligent Cybersecurity Paper Retrieval System API.

## 0.1.0 — 2026-07-20

- Added generic `clue.data-collection.input.v2` and
  `clue.data-collection.output.v2` schemas.
- Added a dependency-free checker for v2 input and output contracts.
- Added `customer-leads` and `literature` collection kinds.
