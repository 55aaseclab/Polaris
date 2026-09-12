---
name: polaris-literature-collection
description: >
  Route literature input validation, source collection, citation expansion,
  PDF augmentation, and manual-review continuation through Polaris.
---

# Polaris literature collection

This skill describes the collection ports in the AutoResearch trial. Read the
common tool's `tools/data-collection/README.md` for detailed contracts, phases,
source catalog, logging, and layout.

## Input contract

Use `clue.data-collection.input.v2` with:

- `collection_kind: "literature"`;
- non-empty `collection_id`, `question`, `decision_context`, `scope`, and
  `source_tasks`;
- an explicit `evidence_policy`;
- `pipeline.review_mode` set to `auto-pass`, `auto-approve`, or
  `manual-review`.

Prefer `crossref-search` / `crossref-doi`, `deepsec-search`, and optional
`semantic-scholar-search`. Citation and reference expansion is handled by the
literature package. Google Scholar and OpenAlex are not implicit sources.

## Execution

Submit `AutoResearch/LiteratureReview` through the Polaris workflow API.
Polaris validates the pinned `packs/autoresearch/main.ord` declaration and
dispatches the `CollectLiteratureSources` and
`AugmentLiteratureCollection` ports through the trial runtime.

## Collection manual review

When the `ResolveManualReview` port returns
`collectionReviewPending`, Polaris persists the trial checkpoint and exposes
the review action on the run detail page. Approval resumes the same trial
with the supplied review result.

## Rules

- Collection results are candidates, not conclusions.
- Preserve source evidence, hashes, checkpoints, rejected records, and
  information gaps.
- Never place provider credentials in input, output, or logs.
- In integrated mode, use a Polaris durable job instead of direct local
  execution or review mutation.
