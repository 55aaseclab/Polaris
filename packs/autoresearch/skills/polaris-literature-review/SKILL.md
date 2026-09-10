---
name: polaris-literature-review
description: >
  Map a literature-review request onto the Polaris v0.4-trial Domain Pack,
  including collection, evidence analysis, human review, and report output.
---

# Polaris literature review

Use this skill as the routing layer for the Polaris-owned AutoResearch Domain
Pack. The public entry point is the Polaris workflow API.

## Mapping

- `survey` → `CollectLiterature` → `polaris-literature-collection`
- `synthesis` → `AnalyzeLiterature` → `polaris-literature-analysis`
- `write` → `WriteLiteratureReport` → `polaris-literature-report`
- human gates → Polaris durable review continuation

The canonical declaration is `packs/autoresearch/main.ord` and explicitly uses
`dsl version "0.4-trial"`. Polaris loads the declaration and runs its
`LiteratureReviewExecution` trial.

## Standard lifecycle

```text
clue.data-collection.input.v2
  → collection sources → citation/reference expansion → PDF augmentation
  → collection review
  → immutable collection snapshot
  → iterate | batches | propose claim graph
  → evidence validation → analysis review
  → final analysis
  → compress → outline → expand report
  → four reviews → bounded revision → Markdown / TeX / BibTeX / PDF
```

Do not invent evidence, bypass a review gate, or call a lower-level executor
as a product path. Use synthetic fixtures and `--dry-run` for local checks.

## Runtime boundary

Set `POLARIS_LITERATURE_RUNTIME_MODE=local` for a local run. Integrated mode
uses `POLARIS_LITERATURE_RUNTIME_MODE=polaris` and submits work to a Polaris
durable job; the workflow CLI intentionally refuses direct execution there.
