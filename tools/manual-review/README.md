# Polaris manual-review adapter

This adapter owns durable manual-review state used by workflows. It is
independent of the Polaris Portal and any particular domain.

The input pair is the collector's:

- `manual-review-list.json` (`clue.data-collection.review-list.v1`);
- `non-review-results.json` (`clue.data-collection.non-review.v1`).

The state file is `review-state.json` and the export is
`clue.data-collection.review-output.v1`. Decisions use
`candidate:<duplicate_group_id>` where available, otherwise
`record:<record_id>`. State updates and exports use atomic replacement and keep
the last 100 audit entries.

Direct cell diagnostics:

```sh
./clue-manual-review bootstrap \
  --manual-list <manual-review-list.json> \
  --non-review <non-review-results.json> \
  --state <review-state.json> \
  --output <review-output.json>

./clue-manual-review save \
  --manual-list <manual-review-list.json> \
  --non-review <non-review-results.json> \
  --state <review-state.json> \
  --output <review-output.json> \
  --record-id <record-id> --status approved --note "Reviewed."

./clue-manual-review export \
  --manual-list <manual-review-list.json> \
  --non-review <non-review-results.json> \
  --state <review-state.json> \
  --output <review-output.json>
```

The public workflow command binds those paths to the run manifest and
`complete` reconstructs a final
`clue.data-collection.output.v2` before starting analysis.
