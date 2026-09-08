# ad-content-review (executor, empty)

Internal **intelligence-analysis** executor for
`analysis_kind: ad-content-review`.

Agents and workflows must call **`clue-intelligence-analysis` only**. Do not
invoke this tool from product skills until a real synthesize path exists.

| Layer | Role |
|-------|------|
| Shell | `tools/intelligence-analysis` — IA v2 contracts, freeze collection, publish output |
| This package | Future content-intel algorithm (themes, ad signals, …) |

## Status

**LLM synthesize (default).** Local and production use the same Codex path
(`tools/codex/clue-codex-cli`). The IA shell:

1. Validates `analysis_kind: ad-content-review`
2. Freezes snapshot + task + analysis-input
3. Calls `synthesize` (Codex) → grounded judgments
4. Publishes `clue.intelligence-analysis.output.v2` + optional `outputs/report.md`

`--lexical-only` is **tests-only** offline fallback (not for real analysis).

## CLI

```sh
./ad-content-review version

# Default: Codex LLM
./ad-content-review synthesize \
  --input analysis-input.json \
  --output synth.json \
  --model gpt-5.4

# Offline unit tests only
./ad-content-review synthesize ... --lexical-only

./ad-content-review render-markdown --input ia-output.json --output report.md
```

Model override env: `AD_CONTENT_REVIEW_MODEL` / `INTELLIGENCE_ANALYSIS_MODEL` /
`CODEX_MODEL` (default `gpt-5.4`).

## Input / output

Product contracts stay on the IA shell:

- Input: `clue.intelligence-analysis.input.v2`
- Output: `clue.intelligence-analysis.output.v2`

Upstream collection: `collection_kind: ad-content-intel`
(`tools/data-collection/ad_content/`).
