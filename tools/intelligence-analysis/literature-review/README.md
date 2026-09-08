# literature-review

**Internal executor** for literature intelligence analysis. Product entry is
`tools/intelligence-analysis/clue-intelligence-analysis`, which freezes a
collection snapshot and invokes this tool via subprocess.

Do not treat this CLI as the agent/product surface. Prefer:

```sh
./tools/intelligence-analysis/clue-intelligence-analysis run \
  --input <analysis>/inputs/input.json \
  --analysis-root <analysis>
```

`literature-review` still exposes low-level commands for debugging. It consumes
a management task and immutable snapshot, runs Codex claim extraction
(one-shot, batches, or **iterate**), validates evidence bindings, runs
auto-pass or manual review, and finalizes `output.json` + `report.md`.

It never searches, downloads, or changes source collection data. Those actions
belong to `data-collection`.

## Flow

```text
management task + collection snapshot
  → formatted analysis input
  → local Codex candidate claims   (one-shot or propose-batches)
  → local validation
  → auto-pass (default) or manual-review v2
  → final output.json + report.md
```

### Iterative claim graph (preferred for literature corpora)

```text
seed papers
  → LLM: core claims + first-hand evidence (per paper)
  → create claim nodes
for each next paper:
  → LLM: core claims + evidence
  → LLM: classify vs existing nodes (identical | new | contradictory | uncertain)
  → absorb into typed claim_graph
→ literature-iteration.v1 JSON
→ optional export to analysis-candidates.v2
```

Each paper extraction is classified as `tool_paper`, `measurement_paper`, or
`sok_survey_paper`. Tool papers contribute problem, method, and conclusion
claims; measurement papers contribute problem and measured conclusions; SoK or
survey papers contribute only the paper's own meta-level synthesis. Ordinary
related-work summaries are treated as second-hand information. The graph also
stores extraction focus tags and prevents identical merges across incompatible
paper types or non-overlapping focus.

```sh
./literature-review iterate \
  --input "$ANALYSIS/work/analysis-input.json" \
  --output "$ANALYSIS/work/iteration-corpus.json" \
  --work-dir "$ANALYSIS/work/iterate-runs" \
  --seed-ids "doi:10.1145/3808103" \
  --export-candidates "$ANALYSIS/work/candidates.json"
```

Data model: `tools/intelligence-analysis/literature-review/schemas/clue.intelligence.literature-iteration.v1.schema.json`
(`claim_graph.nodes` / `edges`, per-paper `iterations[]` with extractions,
judgments, and graph actions).

The finalizer rejects missing, pending, or revision-mismatched reviews.
`review_policy.mode` is an explicit choice: `auto-pass` (default),
`auto-approve`, or `manual-review`.

## Local Codex configuration

`propose` and `propose-batches` use one persistent local Codex CLI session. The
session configuration and credentials remain owned by Codex; the analysis tool
does not read, transmit, or write model API keys. The execution boundary is in
[`backend.lock.json`](backend.lock.json).

## Contracts

- Task: `schemas/clue.intelligence.analysis-task.v2.schema.json`
- `schemas/clue.intelligence.collection-snapshot.v2.schema.json`
- Formatted input: `schemas/clue.intelligence.analysis-input.v2.schema.json`
- `schemas/clue.intelligence.analysis-candidates.v2.schema.json`
- Final output: `schemas/clue.intelligence.analysis-output.v2.schema.json`
- Human review: `schemas/clue.manual-review.v2.schema.json`

### Management task

```json
{
  "schema_version": "clue.intelligence.analysis-task.v2",
  "case_id": "case-example",
  "question": "What does the collected evidence establish?",
  "decision_context": "A synthetic decision context.",
  "audience": "management",
  "collection_snapshot_id": "snapshot-example",
  "coverage_mode": "selected_evidence",
  "review_policy": {
    "minimum_confidence": 0.75,
    "review_all_claims": false,
    "mode": "auto-pass"
  }
}
```

`coverage_mode` is `selected_evidence` by default. Use `all_observations` when
the analysis must place every frozen source observation in at least one claim.
The check applies to the completed claim set, not to each claim in isolation.

### Collection snapshot

The model can only refer to a supplied `clue_id` and `observation_id`. It must
copy the associated `quote` exactly; paraphrased evidence is rejected.

Candidate PDF URLs may appear in collection metadata, but they are not analysis
evidence or file attachments. Every delivered claim remains bound to a frozen
quoted observation.

```json
{
  "schema_version": "clue.intelligence.collection-snapshot.v2",
  "snapshot_id": "snapshot-example",
  "created_at": "2026-01-01T00:00:00Z",
  "clues": [
    {
      "clue_id": "clue-001",
      "source_url": "https://source.example/item",
      "observed_at": "2026-01-01T00:00:00Z",
      "content_hash": "sha256:…",
      "observations": [
        {
          "observation_id": "observation-001",
          "quote": "Exact source text.",
          "locator": "paragraph=1"
        }
      ]
    }
  ]
}
```

## Commands

Run `version` to inspect the wrapper and model-provider boundary.

```sh
./literature-review version
```

Use the workspace's `intelligence/analysis` directory. `$ANALYSIS` below is
that directory for one workspace.

### 1. Prepare formatted input

```sh
./literature-review prepare \
  --task "$ANALYSIS/inputs/case-example/task.json" \
  --snapshot "$ANALYSIS/inputs/case-example/collection-snapshot.json" \
  --output "$ANALYSIS/work/case-example/analysis-input.json"
```

This validates both source contracts and freezes an `analysis-input.json`
document with stable task and snapshot hashes.

### 2. Generate formatted candidate claims

```sh
./literature-review propose \
  --input "$ANALYSIS/work/case-example/analysis-input.json" \
  --output "$ANALYSIS/work/case-example/candidates.json" \
  --run-dir "$ANALYSIS/runs/20260719-case-example-propose-1"
```

The system prompt is
[`prompts/candidate-claims.v1.md`](prompts/candidate-claims.v1.md). The user
message is one JSON object containing only the prepared input. The CLI rejects
invalid schemas, unknown evidence IDs, and altered evidence quotations.

Each model claim has these fields:

```text
claim_id, title, statement, classification, status, risk_level, confidence,
evidence, questions, limitations
```

`classification` is `identical`, `contradictory`, `new`, or `uncertain`.
`status` is `supported`, `contradicted`, `inconclusive`, or
`insufficient_evidence`.

### 3. Validate and complete review

```sh
./literature-review validate \
  --input "$ANALYSIS/work/case-example/analysis-input.json" \
  --candidates "$ANALYSIS/work/case-example/candidates.json" \
  --output "$ANALYSIS/work/case-example/validated.json"

./literature-review auto-pass \
  --input "$ANALYSIS/work/case-example/analysis-input.json" \
  --validated "$ANALYSIS/work/case-example/validated.json" \
  --output "$ANALYSIS/work/case-example/automatic-review-result.json"
```

The default `auto-pass` path bypasses the human queue. `auto-approve` records
automatic approvals and also writes a review list for audit. Validation stores
the resolved evidence bindings, so later stages never create a source from
claim-supplied text.

Set `review_policy.mode` to `manual-review` to use the human-review path:

```sh
./literature-review review-list \
  --input "$ANALYSIS/work/case-example/analysis-input.json" \
  --validated "$ANALYSIS/work/case-example/validated.json" \
  --output "$ANALYSIS/outputs/case-example/manual-review-list.json"
```

Review is required for high-risk, contradictory, uncertain, unsupported, or
low-confidence claims, and whenever `review_all_claims` is enabled. The list
uses the generic `clue.manual-review.v2` contract. Its `revision_hash` includes
the bound claim and evidence, so changed evidence invalidates prior approval.

### 4. Complete human review

Open `manual-review-list.json` through the Polaris review surface. Its review
adapter stores decisions and, on completion, writes
`work/manual-review/review-result.json` with approved, rejected, and pending
records.

### 5. Generate the final output and report

For the default auto-pass path, use its automatic review result:

```sh
REVIEW_RESULT="$ANALYSIS/work/case-example/automatic-review-result.json"

./literature-review finalize \
  --input "$ANALYSIS/work/case-example/analysis-input.json" \
  --validated "$ANALYSIS/work/case-example/validated.json" \
  --review-result "$REVIEW_RESULT" \
  --output "$ANALYSIS/outputs/case-example/output.json" \
  --report "$ANALYSIS/outputs/case-example/report.md"
```

For human review, set `REVIEW_RESULT` to
`$ANALYSIS/work/case-example/manual-review/review-result.json` instead.

`output.json` is the machine-readable final handoff to management. `report.md`
is rendered from the same approved output. It includes only approved or
non-review-required judgments, source URLs, unresolved items, and rejected
claims; it makes no further model call or new conclusion.

[`prompts/report.v1.md`](prompts/report.v1.md) documents this rendering
boundary.

## Verification

```sh
python3 -m py_compile runner.py
python3 -m unittest discover -s tests -v
```
