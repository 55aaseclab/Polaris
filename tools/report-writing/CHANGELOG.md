# Changelog

## Unreleased

- Local Codex review/draft calls now snapshot JSON attachments and keep
  `resume` sandboxed read-only, so a resumed thread cannot delete the live
  `draft.json`. Review reuses completed dimension responses only for the
  same draft hash. Polar `publish` re-reviews a stale `reviews.json`,
  treats `pass` without issues as pass even if the score is low, and after
  one extra revise cycle can publish with residual reviewer issues.
- Zero-result literature collections are now valid report inputs: empty
  `references[]` and evidence registries produce an explicit no-findings
  report and still render Markdown, BibTeX, TeX, and PDF artifacts.
- Outline/expand prompts: if `decision_context` lists exact top-level
  subsection headings or narrative order, follow them; otherwise keep the
  generic survey outline behavior (task-specific structure stays in workflow
  `decision_context`, not hard-coded in shared prompts).
- Removed report-writing `venue_filter` / `arxiv_corr` claim-filter support.
  Exclude arXiv+CoRR at data-collection via `allow_arxiv_corr: false`.
- Subsubsection nesting is claim-budgeted: each `\\subsubsection` needs at least
  `MIN_CLAIMS_PER_SUBSUBSECTION` (3) inherited claims after partition. Themes
  below `2 ×` that threshold expand flat; surplus planned subsubs are capped so
  empty leaves are not emitted.

## 0.4.0 - 2026-07-26

- Literature drafting is **compress → outline → expand → reconcile**
  (`literature_pipeline.py`): claim cards reduce to main arguments, an outline
  plans themes, then each unit expands with a local claim subset. Artifacts
  land under `<draft-dir>/pipeline/`. One-shot full-registry drafting remains
  only for non-literature templates.
- Findings structure: section intro, thematic `\\subsection`s, nested
  `\\subsubsection`s for long themes, and a closing Summary subsection.
- Outline plans **subsubsections** under each findings subsection; expand
  writes nested draft nodes; LaTeX/Markdown render `\\subsubsection`.
- Intro / summary prompts: `expand-findings-intro.v1.md`,
  `expand-findings-summary.v1.md`.
- Reject oversized literature citation clusters (`[@a;b;…]` with more than 5
  ids) during draft validation; expand prompts enforce the same cap.
- `draft --no-resume` forces a fresh literature pipeline run.
- Added `run` (prepare + draft + LaTeX PDF), `literature-report` template, and
  literature-oriented `research-brief` skeleton.
- Default report model is `gpt-5.4` with `model_reasoning_effort=medium`.
- Inline `[@claim-id]` markers for literature; no separate Evidence dumps.
- Stable Codex session per report case for cache-friendly resumes.

## 0.3.0 - 2026-07-21

- Replaced the external model backend with a persistent local Codex session for
  drafting, review, and revision.
- Added the collection search scope to prepared input and formal LaTeX reports.

## 0.2.0 — 2026-07-20

- Preserved source bibliographic metadata through report preparation and added
  a deduplicated `references[]` registry to report input.
- Added formal LaTeX, BibTeX, and XeLaTeX PDF generation with in-text
  citations and a References section.

## 0.1.0 — 2026-07-19

- Added evidence-bound report input preparation from final intelligence output.
- Added intelligence, risk, decision-memo, and research-brief templates.
- Added structured drafting, revision, and four-dimension review passes.
- Added reviewer-gated Markdown and report-manifest publication.
