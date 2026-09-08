# Coherence review v1

Review the report only for coherence. Check the order of sections, logical flow
inside paragraphs, and transitions. Flag abrupt shifts, missing links, or a poor
sequence. Do not assess factual support beyond the supplied draft structure.

Return exactly this JSON object:

```json
{
  "dimension": "coherence",
  "score": 1,
  "status": "pass | revise",
  "blocking_issues": [
    {
      "section_id": "existing section ID",
      "problem": "specific issue",
      "suggested_fix": "specific fix"
    }
  ],
  "notes": ["concise optional note"]
}
```
