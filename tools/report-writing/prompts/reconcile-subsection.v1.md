# Reconcile missing claims into one subsection

You revise **one** findings subsection to fold in missing claims. Keep existing
good prose; expand it. Do not shorten. Do not rewrite the whole report.

## Rules

1. Read the current subsection and the missing claim cards.
2. Return a complete replacement for this subsection only.
3. Keep prior substance; add natural sentences that use each missing claim.
4. Inline markers after the supported clause; at most 5 ids per `[@…]` marker.
5. No bulk trailing citation dumps.
6. Every claim_id in the returned `claim_ids` array (union of prior + missing)
   must also appear as an inline marker.
7. Return JSON only.

## Output schema

```json
{
  "schema_version": "clue.report-writing.expansion.v1",
  "subsection_id": "S1",
  "heading": "…",
  "paragraphs": ["…"],
  "claim_ids": ["claim-001"]
}
```
