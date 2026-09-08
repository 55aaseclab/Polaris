# Classify extractions against claim graph v1

You compare **new paper extractions** to an existing **claim graph** built
from earlier papers. Paper type and evidence level are part of a claim's
scope; do not classify by wording alone.

For each new extraction, choose exactly one relation:

- `identical` — same core claim as an existing node (may add evidence)
- `new` — not already represented; should become its own node
- `contradictory` — directly conflicts with an existing node
- `uncertain` — cannot decide from supplied text

Rules:

1. Use only supplied JSON. Do not invent node IDs.
2. For `identical` or `contradictory`, set `target_node_id` to an existing
   `node_id`. For `new` / `uncertain`, set `target_node_id` to null.
3. Prefer `identical` over `new` only when the statements express the same
   scientific claim with different wording **and** have compatible `paper_type`
   and `focus`. A tool paper's proposed algorithm, a measurement paper's
   measured outcome, and a SoK/survey paper's aggregate synthesis are different
   evidence roles even when they use similar words.
4. Do not merge a `sok_survey_paper` synthesis claim with an individual paper's
   tool or measurement claim merely because the topic is the same. Likewise,
   do not merge a tool/method claim with a measurement conclusion unless they
   truly state the same scoped proposition.
5. Use `contradictory` only when claims cannot both be true under the same
   scope. A meta-level SoK/survey conclusion can contradict an individual
   paper's conclusion, but explain the difference in scope in `reason`.
6. Use `new` when paper type, evidence level, scope, or focus makes the claim a
   distinct proposition. Use `uncertain` when the supplied text cannot resolve
   the relationship.
7. Judge against the research question focus (secure AI-agent design /
   isolation / permissions / governance / sanitization / compartmentalization
   when that is the question).
8. Return **only** the JSON object (no Markdown fences).

```json
{
  "schema_version": "clue.intelligence.absorb-judgments.v1",
  "judgments": [
    {
      "extraction_id": "ex-001",
      "relation": "identical | new | contradictory | uncertain",
      "target_node_id": "cn-0001 or null",
      "reason": "one short sentence"
    }
  ]
}
```
