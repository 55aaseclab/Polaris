# Changelog

## Unreleased

- Physically moved the literature-review and ad-content-review modules under
  `tools/intelligence-analysis/`; the IA shell remains the only product entry.
- Moved IA input/output **v2** JSON Schema to repository root `schemas/`
  (same layout as data-collection); removed `tools/intelligence-analysis/schemas/`.
- Accept ``analysis_kind: ad-content-review`` on the IA v2 input contract and
  publish LLM-synthesized judgments from the internal module.
- Make ``review_policy.auto_pass`` the default: skip heavy ``review-list`` and
  use literature-review ``auto-pass`` before finalize. Final output includes
  the approval mode and automatic-review artifact; ``auto_approve`` is legacy.
- Default literature `iterate` model is **`gpt-5.4`** with
  **`medium`** reasoning effort (input fields `model` /
  `model_reasoning_effort`, or env overrides). Previously
  `gpt-5.4-mini` without explicit reasoning config.

## 0.1.0 — 2026-07-20

- Added v2 input and output schemas plus a dependency-free contract checker.
