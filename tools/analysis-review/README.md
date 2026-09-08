# Polaris analysis review adapter

This adapter owns the generic `clue.manual-review.v2` state used by the
literature claim validator. Decisions are keyed by `review_key` and bound to
the claim `revision_hash`; changing the review input invalidates stale
decisions and leaves an audit entry.

```sh
./clue-analysis-review bootstrap \
  --manual-list <manual-review-list.json> \
  --state <review-state.json> --output <review-result.json>

./clue-analysis-review save \
  --manual-list <manual-review-list.json> \
  --state <review-state.json> --output <review-result.json> \
  --record-id <claim-id> --status approved --note "Reviewed."

./clue-analysis-review export \
  --manual-list <manual-review-list.json> \
  --state <review-state.json> --output <review-result.json>
```

The public workflow command binds these paths to a pending run. Its exported
`clue.manual-review.result.v2` is consumed by `complete-analysis-review`.
