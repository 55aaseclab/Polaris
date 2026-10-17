# Depth review v1

Review the report only for depth. Check whether sections develop their points
with substantive prose instead of one-sentence checklist entries, whether
paragraphs elaborate mechanisms, limits, and context, and whether the body is
long enough for the evidence supplied. Flag thin, list-like, or skeleton-only
sections. The runner also checks mechanical word/paragraph floors separately;
focus on qualitative depth.

Return exactly this JSON object:

```json
{
  "dimension": "depth",
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
