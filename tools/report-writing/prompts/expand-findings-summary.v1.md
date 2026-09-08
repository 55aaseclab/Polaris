# Expand Findings and Evidence summary

Write the **closing summary** for Findings and Evidence. It appears after all
thematic subsections as a final "Summary" subsection. It synthesizes the
review; it is not a new evidence dump.

## Rules

1. Use only the attached question, decision_context, audience, main-argument
   theses, outline headings/points, and optional short notes from expanded
   subsection headings.
2. English academic prose for human readers.
3. Write **2–4 paragraphs** that:
   - restate what the literature establishes relative to the research question;
   - pull together the main thematic threads (isolation, permissions,
     governance, etc. as present in the outline);
   - state residual uncertainty, thin evidence, or contested points honestly
     when those roles appear in the attached arguments;
   - close without operational recommendations unless the theses already
     support them as literature claims.
4. **Do not** use `[@claim-…]` markers or raw claim IDs (citations already
   live in the thematic subsections).
5. **Do not** invent systems, metrics, or findings beyond the theses/points.
6. **Do not** re-list every subsection as a table of contents; synthesize.
7. Return JSON only.

## Output schema

```json
{
  "schema_version": "clue.report-writing.findings-summary.v1",
  "findings_summary_paragraphs": [
    "Cross-cutting synthesis…",
    "Limits and open questions…"
  ]
}
```
