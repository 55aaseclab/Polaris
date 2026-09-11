# clue-intelligence-analysis

**Product shell** for intelligence analysis. Its literature and ad-content
algorithms live in the two internal modules below.

| Layer | Tool | Role |
|-------|------|------|
| Shell | `clue-intelligence-analysis` | Contracts, freeze collection → snapshot, orchestrate, publish v2 output |
| Internal module | `tools/intelligence-analysis/literature-review` | `analysis_kind: literature-review` — claim extract / iterate / finalize |
| Internal module | `tools/intelligence-analysis/ad-content-review` | `analysis_kind: ad-content-review` — LLM synthesize + optional `report.md` |

Agents and workflows **must call this tool only**. Do **not** invoke
executors directly from skills or product commands; the shell owns the
subprocess boundary.

## Commands

```sh
./clue-intelligence-analysis validate-input --input inputs/input.json
./clue-intelligence-analysis prepare --input inputs/input.json --analysis-root .
./clue-intelligence-analysis run --input inputs/input.json --analysis-root .
```

In integrated Polaris mode, only `version`, `validate-input`, and
`validate-output` are available. `prepare`, `run`, `finalize`, and
`complete-review` fail before reading or writing workflow state. Polaris must
submit, execute, retry, and audit those operations as durable jobs. The full
command set remains available in standalone mode.

Canonical JSON Schema files live in the **repository root** `schemas/` only:

- Input v2: [`schemas/clue.intelligence-analysis.input.v2.schema.json`](../../schemas/clue.intelligence-analysis.input.v2.schema.json)
- Output v2: [`schemas/clue.intelligence-analysis.output.v2.schema.json`](../../schemas/clue.intelligence-analysis.output.v2.schema.json)

`run` freezes evidence, then dispatches by `analysis_kind`, then maps results
into `clue.intelligence-analysis.output.v2`.

| `analysis_kind` | Status |
|-----------------|--------|
| `literature-review` | Wired to `tools/intelligence-analysis/literature-review` |
| `ad-content-review` | Wired to `tools/intelligence-analysis/ad-content-review` — **LLM** judgments + optional `report.md` |
| `business-analysis` / `product-analysis` | Reserved, not wired |

## Literature method

Optional input field `literature_method` (default **`iterate`**):

| Value | Executor path |
|-------|----------------|
| `iterate` | seed → per-paper extract → identical/new/contradictory absorb |
| `batches` | legacy `propose-batches` |
| `propose` | single-shot `propose` (tiny corpora) |

Optional: `seed_paper_ids` / `seed_record_ids`, `max_papers` (dry runs),
`batch_size` (batches only).

Optional model (iterate default **`gpt-5.5`** with **`low`** reasoning):

- `model` — Codex model id (override env: `INTELLIGENCE_ANALYSIS_MODEL` /
  `LITERATURE_REVIEW_MODEL` / `CODEX_MODEL`)
- `model_reasoning_effort` — e.g. `low` (override env:
  `INTELLIGENCE_ANALYSIS_REASONING_EFFORT` /
  `LITERATURE_REVIEW_REASONING_EFFORT`)

## Input sketch

```json
{
  "schema_version": "clue.intelligence-analysis.input.v2",
  "analysis_id": "…",
  "analysis_kind": "literature-review",
  "question": "…",
  "decision_context": "…",
  "audience": "…",
  "literature_method": "iterate",
  "model": "gpt-5.5",
  "model_reasoning_effort": "low",
  "collection_ref": {
    "collection_id": "…",
    "collection_output_sha256": "sha256:…",
    "collection_output_path": "…/outputs/output.json"
  },
  "review_policy": {
    "minimum_confidence": 0.75,
    "review_all_claims": true,
    "mode": "auto-pass"
  }
}
```

`review_policy.mode` is one of `auto-pass`, `auto-approve`, or
`manual-review`, and defaults to `auto-pass`.

- `auto-pass` bypasses the review queue and finalizes without human action.
- `auto-approve` creates an auditable `manual-review-list.json`, then resolves
  required claims automatically.
- `manual-review` writes `outputs/manual-review-list.json` and holds the
  analysis at `pending_manual_review` until the portal completes review.

In standalone mode, open the review list in the admin portal. Its completion
action writes the review result and invokes the following stage-finalization
command:

```sh
./clue-intelligence-analysis complete-review \
  --analysis-root <analysis-root> \
  --review-result <analysis-root>/work/manual-review/review-result.json
```

In integrated Polaris mode, the portal rejects this completion action before
writing review state or launching the tool. Polaris must enqueue the review
completion as a durable analysis job instead.
