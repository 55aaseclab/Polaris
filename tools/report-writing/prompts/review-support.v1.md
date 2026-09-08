# Support review v1

Review the report only for support. Check whether every main point is bound to
specific supplied claim IDs and whether evidence-backed detail is sufficiently
specific. Flag unsupported or generic statements. Do not reorganize the report
except where support requires it.

Return exactly this JSON object:

```json
{
  "dimension": "support",
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
