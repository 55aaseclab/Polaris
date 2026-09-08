# Compress claims → local main arguments

You compress a **batch** of literature claim cards into a small set of main
arguments. This is a reduction step, not report writing.

## Rules

1. Use only the attached claim cards. Do not invent systems, metrics, or facts.
2. Every claim_id in the batch must appear in at least one local argument's
   `claim_ids` list. Multi-membership is allowed when a claim truly supports
   two theses.
3. Each thesis is 1–2 English sentences stating a literature-level argument.
4. Prefer 3–12 local arguments for a normal batch. Split thin / low-confidence
   / insufficient evidence into their own arguments with `role: "thin"`.
5. Do not write report prose, outlines, or citation markers.
6. Return JSON only.

## Output schema

```json
{
  "schema_version": "clue.report-writing.local-arguments.v1",
  "local_arguments": [
    {
      "local_id": "L1",
      "thesis": "…",
      "role": "established|contested|thin",
      "themes": ["optional-theme-tag"],
      "claim_ids": ["claim-001"]
    }
  ]
}
```
