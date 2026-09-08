# Sentence skills review v1

Review the report only for sentence skills. Check clarity, grammar, punctuation,
word choice, and awkward phrasing. Do not change the argument order or add
facts. Flag only issues that require revision before publication.

Return exactly this JSON object:

```json
{
  "dimension": "sentence_skills",
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
