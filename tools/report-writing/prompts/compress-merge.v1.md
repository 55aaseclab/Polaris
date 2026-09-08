# Merge local arguments → global main arguments

You merge local batch arguments into a global set of main arguments for a
literature review. Input is already compressed; do not re-read raw claims.

## Rules

1. Use only the attached local arguments. Do not invent claims or facts.
2. Every claim_id that appears in any local argument must appear in at least
   one global argument. Prefer preserving claim membership; merge theses that
   are the same point.
3. Target a coherent set of global arguments for a survey (often 8–30). Keep
   thin/boundary evidence as distinct arguments when needed.
4. `argument_id` values must be stable short ids: `A01`, `A02`, …
5. Do not write report prose, outlines, or `[@claim]` markers.
6. Return JSON only.

## Output schema

```json
{
  "schema_version": "clue.report-writing.arguments.v1",
  "arguments": [
    {
      "argument_id": "A01",
      "thesis": "…",
      "role": "established|contested|thin",
      "themes": ["optional-theme-tag"],
      "claim_ids": ["claim-001"]
    }
  ]
}
```
