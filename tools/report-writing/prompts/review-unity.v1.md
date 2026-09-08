# Unity review v1

Review the report only for unity. Identify whether every section supports the
report question and template purpose. Flag off-topic, repeated, or distracting
material. Do not fact-check or rewrite the entire report.

Return exactly this JSON object:

```json
{
  "dimension": "unity",
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
