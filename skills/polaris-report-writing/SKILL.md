---
name: polaris-report-writing
description: >
  Turn a final v2 intelligence-analysis output into a reviewer-gated report.
  Use when Codex needs to select a report kind, freeze report input, draft,
  review, revise, or publish an evidence-bound report.
---

# Polaris 报告写作

This skill only consumes a final `clue.intelligence-analysis.output.v2` from:

```text
<workspace>/intelligence-analysis/<analysis-id>/outputs/output.json
```

It never reads collection runs or analysis work files directly.

## Report kinds / templates

Tool templates (see `tools/report-writing templates`):

- `literature-report`: research question, search scope, multi-subsection
  findings with fused evidence and inline `[@claim-id]` cites; full claim
  coverage via resumed Codex fills (not a short memo).
- `research-brief`: same literature-oriented skeleton as `literature-report`.
- `intelligence-report` / `decision-memo` / `risk-brief` / `system-framework`:
  non-literature product paths.

Skill-level product kinds still map to those templates; for literature
analysis prefer **`literature-report`**.

Select a kind from the final analysis kind and audience; do not use a report
template to introduce a new conclusion.

## Fixed literature workflows (`packs/autoresearch`)

When the case is registered as a `literature-review` workflow, prefer:

```sh
pnpm --dir apps/polaris run polaris -- literature-review run \
  --input <input.json> --workspace <workspace-id> --run-id <run-id>
```

Report stage bindings live under `stages.report-writing` (`report_id`,
`root_path`, `template`, `steps`). The workflow runner invokes
`clue-report-writing run` with `{{analysis_output}}`, `{{report_*}}`, and
stable case session at `<report-root>/runs/codex-session.json`.

Example: `pkvm-security-20260723` uses `template: literature-report`.

If `steps: []`, reuse prepared PDF/artifacts; do not re-run report-writing
unless the user asks.

## Standard scope

```text
<workspace>/report-writing/<report-id>/
├── case/
├── inputs/
├── work/
├── runs/
└── outputs/
```

`inputs/input.json` references the final analysis output and its SHA-256.
The report-writing tool freezes that projection, then drafts, reviews, revises,
and publishes only after all four review dimensions pass.
