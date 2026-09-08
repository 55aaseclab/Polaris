---
name: polaris-literature-collection
description: >
  Route literature input validation, source collection, citation expansion,
  PDF augmentation, and collection manual-review continuation through Polaris.
---

# Polaris literature collection

This skill is a thin router over the migrated collection tools. Read the
common tool's `tools/data-collection/README.md` for detailed
contracts, phases, source catalog, logging, and layout.

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

## Commands

```sh
WORKFLOW=workflows/literature-review

$WORKFLOW/polaris-literature-review validate --input <input.json>
$WORKFLOW/polaris-literature-review run \
  --input <input.json> --workspace <workspace-id> --run-id <run-id> \
  --network allow --review-mode auto-pass
```

Use `--dry-run` to validate and write a planned run manifest. Use
`--collection-output <output.json>` only for an already validated handoff or
checkpoint resume. `--network deny` rejects new live source requests.

## Collection manual review

When phase 3 returns `pending_manual_review`, the run manifest records the
Polaris-owned queue paths. Inspect and update it through:

```sh
$WORKFLOW/polaris-literature-review collection-review bootstrap \
  --run-manifest <run.json>
$WORKFLOW/polaris-literature-review collection-review save \
  --run-manifest <run.json> --record-id <id> \
  --status approved --note "Reviewed."
$WORKFLOW/polaris-literature-review complete-collection-review \
  --run-manifest <run.json>
```

The state uses a stable `candidate:<duplicate_group_id>` identity when
available, otherwise `record:<record_id>`. Updates are audited and atomically
written. A completed export remains available as
`clue.data-collection.review-output.v1`; the continuation reconstructs a
final `clue.data-collection.output.v2` handoff for analysis.

## Rules

- Collection results are candidates, not conclusions.
- Preserve source evidence, hashes, checkpoints, rejected records, and
  information gaps.
- Never place provider credentials in input, output, or logs.
- In integrated mode, use a Polaris durable job instead of direct local
  execution or review mutation.
