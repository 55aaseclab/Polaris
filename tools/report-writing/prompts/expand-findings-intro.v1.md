# Expand Findings and Evidence introduction

Write the **section-level introduction** for Findings and Evidence only.
This sits under the section heading and **before** any thematic subsections.
It is a roadmap and synthesis frame—not the full review body.

## Rules

1. Use only the attached question, decision_context, audience, main-argument
   theses, and outline subsection headings/points.
2. English academic prose for human readers.
3. Write **2–4 paragraphs** that:
   - restate what the findings section will establish (tied to the question);
   - preview the thematic structure in outline order (subsection headings);
   - if `decision_context` fixes structure or narrative order, reflect that
     briefly in the roadmap;
   - note that evidence is integrated with inline citations in the subsections
     that follow (do not invent citation markers here);
   - optionally flag thin/contested themes if those roles appear in the
     attached arguments.
4. **Do not** use `[@claim-…]` markers or raw claim IDs.
5. **Do not** invent systems, metrics, or findings beyond the theses/points.
6. **Do not** write the subsection bodies—only the section intro.
7. Return JSON only.

## Output schema

```json
{
  "schema_version": "clue.report-writing.findings-intro.v1",
  "findings_intro_paragraphs": [
    "Opening frame for the findings section…",
    "Roadmap of themes in the order they will appear…"
  ]
}
```
