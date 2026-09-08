# Changelog

## Unreleased

- Iterative literature extraction now classifies every paper as a
  `tool_paper`, `measurement_paper`, or `sok_survey_paper`, scopes claims with
  `problem` / `method` / `conclusion` focus tags, and keeps SoK/survey evidence
  at the meta-synthesis level. Graph classification and candidate export carry
  the type metadata and reject incompatible identical merges.
- Add **`auto-pass`** as the default (and lighten **`auto-approve`**): approve
  all required claims without rebuilding PDF fulltext or expanding a full
  manual-review dossier. Set ``review_policy.auto_pass=false`` for human
  review. Validation persists trusted evidence bindings, and final output
  records the approval mode.
- Iterate default model is **`gpt-5.4`** with **`medium`**
  `model_reasoning_effort` (was `gpt-5.4-mini`). Override via CLI
  `--model` / `--reasoning-effort` or env
  `LITERATURE_REVIEW_MODEL` / `LITERATURE_REVIEW_REASONING_EFFORT`.
- Validate candidate evidence against PDF fulltext chunk observations
  (``{paper_id}:pdf-chunk-NN``) produced during iterate extract, and repair
  truncated quotes / mis-copied observation ids via the same flexible bind
  rules as iterate. Fixes post-iterate ``validate`` failures such as
  ``references an unknown clue or observation`` when claims cite fulltext.
- Iterate extract: sanitize illegal JSON control characters; soft-bind evidence
  to a paper observation when quote match fails; requeue zero-extraction papers
  on resume so thin corpora (e.g. few bibliography entries) can recover.

## 0.4.1 — 2026-07-23

- Stopped rendering a "Search Scope and Reproducibility" section in the
  deterministic `report.md`. `search_scope` remains on the JSON output for
  report-writing to present.

## 0.4.0 — 2026-07-23

- Added **iterative claim-graph** algorithm (`iterate` command):
  seed papers → core claim+evidence extraction → absorb further papers as
  `identical` / `new` / `contradictory` / `uncertain` into a typed graph.
- Schema: `schemas/clue.intelligence.literature-iteration.v1.schema.json`.
- Prompts: `extract-paper-claims.v1.md`, `classify-against-graph.v1.md`.
- Optional `--export-candidates` for the existing validate/finalize path.

## 0.3.0 — 2026-07-21

- Replaced the external model backend with a persistent local Codex session.
- Removed file attachments from frozen analysis snapshots. Candidate links
  remain collection metadata for manual acquisition only.

## 0.2.1 — 2026-07-20

- Added explicit `review_policy.auto_approve` and an auditable `auto-approve`
  command for non-human approval runs.

## 0.2.0 — 2026-07-20

- Replaced all literature-review task, snapshot, prepared-input, candidate,
  validated-result, and final-output contracts with v2 schema versions.
- Rejected v1 analysis contracts at every CLI boundary.

## 0.1.0 — 2026-07-19

- Added structured task and collection-snapshot preparation for intelligence
  analysis.
- Added structured candidate-claim generation with JSON-only input and output.
- Added local evidence validation and generic manual-review v2 handoff.
- Added final `output.json` and deterministic `report.md` generation after
  required reviews are resolved.
