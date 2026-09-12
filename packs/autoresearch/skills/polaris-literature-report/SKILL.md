---
name: polaris-literature-report
description: >
  Turn final Polaris literature analysis into a fully covered, reviewed,
  evidence-bound Markdown, TeX, BibTeX, and PDF report.
---

# Polaris literature report

This skill consumes only a final
`clue.intelligence-analysis.output.v2`. It does not re-read collection runs,
raw PDFs, or analysis work files as a source of new conclusions.

## Templates

Use `literature-report` for a full literature review and `research-brief` for
the same evidence-bound skeleton with a shorter brief. The report pipeline is:

```text
prepare → compress → outline → expand → structural validation
  → unity / support / coherence / sentence-skill reviews
  → bounded revision → publish Markdown → TeX / BibTeX → two-pass XeLaTeX PDF
```

All published claims retain inline `[@claim-id]` evidence markers and the
report manifest retains input, draft, review, and artifact hashes. The four
review dimensions must pass before Markdown publication.

## Execution

Submit the `AutoResearch/LiteratureReview` flow through the Polaris workflow
API. The `LiteratureReview` flow routes report preparation, review,
publication, and PDF rendering through its declared ports.

## Rules

- Do not introduce conclusions absent from final analysis.
- Preserve full claim coverage and exact evidence references.
- Keep rejected and unresolved material in the appropriate audit fields.
- Treat PDF/TeX dependencies as disposable-cell prerequisites.
- Integrated report production is a Polaris durable job, not a direct workflow
  invocation.
