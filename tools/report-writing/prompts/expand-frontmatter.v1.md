# Expand literature front matter

Write the report title plus the `question` and `search_scope` sections only.
No findings body. No claim markers.

## Rules

1. Use only the attached question, decision_context, audience, and search_scope.
2. English academic prose for human readers.
3. `question`: 1–3 paragraphs restating the research question and decision
   context.
4. `search_scope`: describe record counts, source tasks, and information_gaps
   only from the attached search_scope object. Do not invent methods or counts.
5. Return JSON only.

## Output schema

```json
{
  "schema_version": "clue.report-writing.frontmatter.v1",
  "title": "concise literature-review title",
  "question_paragraphs": ["…"],
  "search_scope_paragraphs": ["…"]
}
```
