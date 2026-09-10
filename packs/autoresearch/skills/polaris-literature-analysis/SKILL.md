---
name: polaris-literature-analysis
description: >
  Freeze a final Polaris collection, build an evidence-bound literature claim
  graph, resolve review, and publish the final analysis output.
---

# Polaris literature analysis

The product path is the Polaris shell and workflow API. The common analysis
tools are implementation bindings and are not a replacement for the shell.

## Handoff

```text
data-collections/<collection-id>/outputs/output.json
  → immutable collection snapshot
  → clue.intelligence.analysis-task.v2
  → iterate | batches | propose
  → candidate validation and exact observation binding
  → review result
  → clue.intelligence-analysis.output.v2
```

Every claim must bind to an observed quote, clue id, observation id, source URL,
timestamp, and content hash. The validator rejects altered quotes, unknown
observations, invalid graph actions, incomplete coverage, and stale revision
hashes.

## Methods and review

- `iterate` seeds a claim graph and absorbs papers as identical, new,
  contradictory, or uncertain;
- `batches` writes bounded batch caches and merges only complete, matching
  caches;
- `propose` retains the single-proposal path for small corpora;
- `auto-pass` skips the human queue with an auditable not-required decision;
- `auto-approve` retains the queue as an automatic audit artifact;
- `manual-review` writes a pending review list until Polaris completes it.

Submit the `AutoResearch/LiteratureReview` flow through the Polaris workflow
API. The trial selects `iterate`, `batches`, or `propose` from its declared
input and routes analysis through the corresponding port.

For a pending analysis review, use `analysis-review bootstrap/save/export` to
create a validated `clue.manual-review.result.v2`, then supply it to
`complete-analysis-review`. A failed continuation retains
`pending_manual_review` and can be retried.

## Prohibitions

- Do not use model knowledge as evidence.
- Do not analyze an unfrozen or altered collection.
- Do not bypass the Polaris review continuation.
- Do not enable direct integrated execution; it requires a Polaris-owned
  disposable execution cell.
