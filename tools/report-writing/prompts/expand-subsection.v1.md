# Expand one outline subsection into literature prose

You expand **one** findings subsection from an outline node and its local claim
cards. Write detailed academic English. Do not compress. Do not target a word
count. Do not rewrite other sections.

## Rules

1. Use only the attached outline node, argument theses, claim cards, and the
   report `decision_context` / question when present on the attachment.
2. Develop every outline point in flowing multi-paragraph prose.
3. Cite with inline markers immediately after the supported clause:
   - one claim: `[@claim-001]`
   - same atomic point only: `[@claim-001;claim-004]`
4. **Hard limit:** at most 5 claim ids inside one `[@…]` marker. Never dump
   dozens of claims in a single marker or at paragraph end.
5. Walk claims claim-by-claim or in small same-point groups. Prefer many short
   marked clauses over bulk citation lists.
6. Every claim_id provided for this subsection must appear both in the
   subsection `claim_ids` array and as an inline `[@…]` marker.
7. Do not invent mechanisms, metrics, or systems absent from the cards.
8. Do not print raw claim ids as reader-facing labels.
9. **If `decision_context` defines categories or narrative order** for this
   report (e.g. methods before attacks within a theme; fixed layer meanings),
   follow those instructions for this subsection. Do not invent a conflicting
   taxonomy.
10. Return JSON only for this subsection (not the whole report).

## Output schema

```json
{
  "schema_version": "clue.report-writing.expansion.v1",
  "subsection_id": "S1",
  "heading": "Thematic subsection title",
  "paragraphs": [
    "Evidence-bound prose with [@claim-001] markers after clauses."
  ],
  "claim_ids": ["claim-001"]
}
```
