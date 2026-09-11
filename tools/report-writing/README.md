# clue-report-writing

`clue-report-writing` turns final intelligence-analysis `output.json` into a
reviewer-gated Markdown report. It is evidence-first and never collects sources
or redoes analysis.

```text
final analysis output
  → formatted report input
  → local Codex structured draft
  → unity / support / coherence / sentence reviews
  → optional local Codex revision
  → published report.md + report.json
```

Only a final `clue.intelligence-analysis.output.v2` artifact is accepted. The
tool never uses rejected claims as report evidence.

## Local Codex configuration

`draft`, `review`, and `revise` share **one stable Codex CLI session per report
case** at:

```text
<report-case>/runs/codex-session.json
```

`--run-dir` is only for audit manifests; regenerations resume the same
`session_id` so large report-input context can hit the provider cache. Override
the session file with `REPORT_WRITING_CODEX_SESSION_PATH`.

Default model is **`gpt-5.5`** with **`model_reasoning_effort=low`**. Override
with:

- `REPORT_WRITING_MODEL` or `CODEX_MODEL`
- `REPORT_WRITING_REASONING_EFFORT`

Codex owns provider credentials; this tool neither reads nor writes API keys.
The execution boundary is in `tools/report-writing/backend.lock.json`.

## Contracts

- `schemas/clue.report-writing.input.v2.schema.json`
- `schemas/clue.report-writing.draft.v2.schema.json`
- `schemas/clue.report-writing.review.v2.schema.json`
- `schemas/clue.report-writing.output.v2.schema.json`

The input is a frozen projection of approved analysis output. Its evidence
registry preserves claim IDs, exact quotations, source URLs, confidence, and
limitations. It also records the analysis-output and collection-snapshot hashes.

## Built-in templates

```sh
./clue-report-writing templates
```

- `ad-content-report`
  Social/ad content intelligence (themes, creatives, corpus scope). Auto-chosen
  when `analysis_kind` is `ad-content-review`.
- `intelligence-report`
  General evidence-backed intelligence report.
- `risk-brief`
  Conflicts, uncertainty, or unsupported judgments are material.
- `decision-memo`
  The audience is management and the report supports a decision.
- `literature-report`
  Literature review: research question, search scope, and multi-subsection
  findings with integrated evidence. Drafting uses **compress → outline →
  expand** (not one full-registry prompt). Every registry claim must be bound
  with dual array + inline `[@claim]` markers; citation clusters are capped
  (default max 5 ids per `[@…]`).
- `research-brief`
  Same literature-oriented skeleton as `literature-report` (question, search
  scope, findings and evidence) with the same pipeline and coverage rules.
- `system-framework`
  Evidence supports an ordered, progressive conceptual system.

`prepare --template auto` chooses `literature-report` when
`analysis_kind` is `literature-review`, else `system-framework` for an ordered
framework, then `risk-brief` for material uncertainty, `decision-memo` for a
management audience, and otherwise `intelligence-report`. Pass a template ID to
choose it explicitly.

## Commands

Use `$ANALYSIS_OUTPUT` for a final file under `intelligence-analysis/<analysis-id>/outputs/`.
Use `$REPORTS` for a human-facing report directory, not an analysis work folder.

### Fixed workflow operation

`run` is the single report-writing operation used by fixed Polaris workflows.
It freezes the analysis output, creates a local-Codex draft, then writes TeX,
BibTeX, and a compiled PDF. Its intermediate artifacts remain inspectable.

```sh
./clue-report-writing run \
  --analysis-output "$ANALYSIS_OUTPUT" \
  --template research-brief \
  --report-input "$REPORTS/input.json" \
  --draft "$REPORTS/work/draft.json" \
  --tex "$REPORTS/outputs/report.tex" \
  --bib "$REPORTS/outputs/references.bib" \
  --output "$REPORTS/outputs/report.pdf" \
  --run-dir "$REPORTS/runs/workflow"
```

The lower-level commands below remain available for manual inspection and
review workflows.

### 1. Freeze report input

```sh
./clue-report-writing prepare \
  --analysis-output "$ANALYSIS_OUTPUT" \
  --template auto \
  --output "$REPORTS/case-example/report-input.json"
```

Optional `--claim-filter` (`clue.report-writing.claim-filter.v1`) keeps or drops
judgments by title/statement regex rules (`mode: include|exclude`). Venue /
arXiv–CoRR exclusion belongs in **data-collection**
(`payload.literature_scope.allow_arxiv_corr`), not report-writing.

### 2. Generate a structured draft

Literature templates run a multi-step pipeline and write inspectable artifacts
under `<draft-dir>/pipeline/`:

```text
claim cards → arguments.json → outline.json
  → frontmatter.json → findings-intro.json → expansions/
  → findings-summary.json → draft.json
```

Findings and Evidence structure:

1. **Section intro** — roadmap paragraphs on the findings section itself
2. **Thematic subsections** (`\\subsection`) — major themes
3. **Subsubsections** (`\\subsubsection`) — focused units under each theme
4. **Summary** — closing subsection synthesizing conclusions (no claim dumps)

Use `--no-resume` to ignore existing pipeline artifacts.

```sh
./clue-report-writing draft \
  --input "$REPORTS/case-example/report-input.json" \
  --output "$REPORTS/case-example/draft.json" \
  --run-dir "$REPORTS/case-example/runs/draft-1"
```

[`prompts/draft.v1.md`](prompts/draft.v1.md) requires a JSON-only response.
It requires every template section in order. Each substantive section must bind
to known claim IDs, and limitations must be copied from the frozen input.

### 3. Run four focused reviewer passes

```sh
./clue-report-writing review \
  --input "$REPORTS/case-example/report-input.json" \
  --draft "$REPORTS/case-example/draft.json" \
  --output "$REPORTS/case-example/reviews.json" \
  --run-dir "$REPORTS/case-example/runs/review-1"
```

The tool makes four structured calls: `unity`, `support`, `coherence`, and
`sentence_skills`. A pass requires a score of at least 8 with no blocking issue.

### 4. Revise when reviewers request it

```sh
./clue-report-writing revise \
  --input "$REPORTS/case-example/report-input.json" \
  --draft "$REPORTS/case-example/draft.json" \
  --reviews "$REPORTS/case-example/reviews.json" \
  --output "$REPORTS/case-example/draft-revised.json" \
  --run-dir "$REPORTS/case-example/runs/revise-1"
```

Run `review` again after revision. A review is tied to one exact draft hash.

### 5. Publish

```sh
./clue-report-writing publish \
  --input "$REPORTS/case-example/report-input.json" \
  --draft "$REPORTS/case-example/draft-revised.json" \
  --reviews "$REPORTS/case-example/reviews-final.json" \
  --output "$REPORTS/case-example/report.md" \
  --manifest "$REPORTS/case-example/report.json"
```

`publish` refuses any reviewer state other than four passes. It renders Markdown
deterministically with claim IDs, exact source URLs, and quotations for cited
sections. `report.json` records the source output hash, draft hash, review hash,
template, claim IDs, and limits used in the report.

## Prompt boundary

- `draft.v1.md` writes only from final evidence and the selected template.
- `review-*.v1.md` checks one quality dimension per call.
- `revise.v1.md` resolves reviewer issues without adding evidence.

No model call may turn rejected claims into conclusions, remove a material
unresolved limit, or cite a source outside the evidence registry.

## Verification

```sh
python3 -m py_compile runner.py
python3 -m unittest discover -s tests -v
```

## PDF export

Render a generated Markdown report to a self-contained HTML file and PDF:

```sh
./clue-report-writing pdf --markdown report.md --output report.pdf
```

The renderer uses a local Chromium-compatible browser and embeds no external
resources.

## Formal LaTeX report

Use the formal renderer for citation-bearing deliverables. It writes a TeX
source file, a deduplicated BibTeX bibliography, and a XeLaTeX-compiled PDF.

```sh
./clue-report-writing latex \
  --input report-input.json \
  --draft draft.json \
  --tex report.tex \
  --bib references.bib \
  --output report.pdf
```

The prepared v2 input has a `references[]` registry derived from the frozen
analysis evidence. Each reference retains title, authors, venue, year, DOI, and
canonical URL when that source metadata is available.
