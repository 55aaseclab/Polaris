# Draft literature report v1

> Note: the default literature `draft` / `run` path no longer uses this prompt
> as a single full-registry write. It runs **compress → outline → expand**
> (`compress-local`, `compress-merge`, `outline`, `expand-subsection`,
> `expand-frontmatter`, `reconcile-subsection`). This file remains for
> documentation and any manual one-shot experiments.

You are writing an evidence-bound literature review from one frozen report
input JSON. That file is the only source of facts. Do not browse, call tools,
invent recommendations, make causal claims beyond the evidence, add metrics
not present in the input, or use outside knowledge.

Write for the stated audience and template. This is a literature review, not a
workflow log. Do not mention prompts, agents, pipelines, JSON keys as jargon,
or internal file paths.

Write every generated title and paragraph in English. This is a literature
review for human readers, not a claim ledger. Do not write labels such as
"Evidence:", "Supporting Evidence", "claim-001", or bullet dumps of claims.
Bibliography entries are produced by the CLI from inline citation markers.

## Input you must fully use

Read the entire report input attachment. Leverage all of:

- `question`, `decision_context`, `audience`
- `search_scope` (record counts, source tasks/configs, information_gaps,
  hashes, rerun command when present)
- `evidence_registry` **in full** — every claim is in-scope material
- each claim's `title`, `statement`, `classification`, `status`, `confidence`,
  `limitations`, and nested `evidence` (source_url, quote, locator, metadata)
- `references` when useful for orientation (do not invent citations)
- `framework` stages when present (preserve progression)
- `allowed_limitations` / unresolved items only if they constrain interpretation
  of claims; do not create a standalone "Scope and Limitations" section unless
  the template includes one

## Output schema

Return exactly one JSON object without Markdown fences or surrounding prose:

```json
{
  "schema_version": "clue.report-writing.draft.v2",
  "report_id": "copy report_input.report_id exactly",
  "template_id": "copy report_input.template.template_id exactly",
  "title": "concise literature-review title",
  "sections": [
    {
      "section_id": "copy one supplied template section ID exactly",
      "paragraphs": ["optional section-level prose"],
      "claim_ids": ["optional section-level claim IDs"],
      "subsections": [
        {
          "heading": "thematic subsection title",
          "paragraphs": ["evidence-bound prose integrating claims and findings"],
          "claim_ids": ["claim IDs supporting this subsection"]
        }
      ]
    }
  ],
  "limitations": ["copy exact entries from report_input.allowed_limitations"]
}
```

## Template sections (required order)

1. Include every template section exactly once, in template order.
2. `question` — restate the research question and decision context in 1–3
   paragraphs. No claim IDs required. Leave `subsections` empty or omit.
3. `search_scope` — describe the collection search scope only from
   `report_input.search_scope`. Cover record count, source tasks (task_id,
   source_type, essential query/config), and information_gaps. Mention hashes
   or rerun command only if present. Do not invent retrieval methods or counts.
   Leave `claim_ids` empty. Leave `subsections` empty or omit.
4. `findings` (Findings and Evidence) — this is the literature review body.
   Write a full academic literature review, not a short executive brief.
   There is **no target length cap** and no requirement to compress. When the
   registry is large, write as much prose as needed to treat the material
   seriously: more subsections, more paragraphs, more specific mechanisms,
   methods, and findings from the claims. Fuse supporting literature into the
   same sentences with inline markers.

   **Section intro (required when using compress→outline→expand):** put 2–4
   roadmap paragraphs on the `findings` section itself (`paragraphs` at the
   section level, not only in subsections). Preview the themes that follow;
   do not put `[@claim-…]` markers in that intro. Subsections then carry the
   evidence-bound body.

   **Closing summary (required when using compress→outline→expand):** end
   findings with a final subsection headed `Summary` (2–4 paragraphs) that
   synthesizes cross-cutting conclusions and residual uncertainty. No claim
   markers in the summary; evidence stays in the thematic subsections.

   Prefer multiple `subsections` (theme, method family, mechanism, threat, or
   framework stage). Each subsection must:
   - have a clear human heading
   - develop the theme in several flowing paragraphs (not one or two summary
     sentences for dozens of claims)
   - cite sources **inline** with claim markers (see below)
   - also list the same claim IDs in that subsection's `claim_ids` array for
     machine validation (arrays are not printed as a report section)

Section-level `paragraphs` on `findings` may open the review; the substance
must live in subsections when more than a handful of claims exist.

## Inline citations (required in findings prose)

Place a machine marker **immediately after the specific clause or finding it
supports**, not at the end of the paragraph.

- one claim: `[@claim-001]`
- several claims for the **same** atomic clause: `[@claim-001;claim-004;claim-012]`
- **No hard cap** on how many claims may support one clause when they truly
  co-support the same point. Prefer natural academic style; do not invent a
  "max 2–3 citations" rule.

The CLI turns each marker into a normal bibliography citation inside the
sentence (for example `\cite{...}` in LaTeX). Write as if you were authoring a
survey paper:

- Good: "Declarative permission policies can contain MCP server behavior without
  server modification [@claim-002], while runtime authorization checks are
  argued to strengthen least-privilege enforcement [@claim-005;claim-007]."
- Bad: one summary sentence, then a single trailing marker listing dozens of
  claims for the whole paragraph
- Bad: a paragraph of claims followed by "Evidence: [1], [2], [3]"
- Bad: "Claim claim-002 states that..."
- Bad: bullet lists that only restate claim titles

**Distribution rule:** as you introduce each distinct finding, attach the
markers for the claims that support *that* finding right there. Walk through
the subsection's claim set claim-by-claim or small same-point groups; do not
hoard markers until the paragraph ends.

Every claim used in a subsection must appear both as `[@claim-…]` in that
subsection's paragraphs and in its `claim_ids` array.

## Coverage and quality rules

1. Use only claim IDs from `evidence_registry`. Never use rejected claim IDs.
2. **Full claim coverage:** every claim_id in `evidence_registry` must appear
   in at least one section or subsection `claim_ids` array **and** as an inline
   `[@claim-…]` marker in prose (typically under `findings`). Do not drop
   low-confidence or insufficient_evidence claims; place them in an
   appropriately labeled subsection (for example, "Thin or insufficient
   evidence") and state their status honestly in natural language.
3. Group claims thematically. Avoid one giant subsection and avoid tiny
   one-claim subsections unless a claim is an outlier.
4. When `framework` is present, align subsection order with stage sequence
   where that fits the evidence; otherwise use coherent literature themes
   (for example isolation, permissions, governance, redirection defenses,
   sanitization, compartmentalization).
5. Every substantive sentence in findings must be supportable by the bound
   claim_ids for that section/subsection. Do not introduce systems, metrics,
   or conclusions not present in those claims.
6. **Do not compress.** Do not aim for a short memo. Prefer multi-paragraph
   narrative synthesis that actually uses the claims. Inventory-style dumps
   are still bad, but brevity is not a goal. Write until the corpus themes are
   covered in enough detail for a real literature review.
7. Copy `limitations` exactly from `allowed_limitations` (the CLI may also
   normalize this field). Do not invent a limitations narrative section.
8. Never print raw claim IDs, observation IDs, or "Evidence:" labels in the
   visible prose—only the `[@claim-…]` markers, which readers never see as
   IDs.
9. If you cannot finish every claim in one pass, still write a long, detailed
   body for the claims you cover well. A later resume turn may ask you to
   fold in remaining unused claims—do not pre-emptively shrink the draft.
