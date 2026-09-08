# Polaris literature-review workflow

This directory contains the Polaris literature-review workflow runner, DSL
declaration, examples, skills, and environment setup. Canonical wire schemas
live in the repository-level `schemas/` directory. The implementation calls
the common tools in `tools/`; it does not import, execute, or read
configuration from Wanghai.

The canonical workflow declaration is
`workflows/literature-review/main.ord`.
The workflow preserves the existing `clue.*.v2` wire contracts so existing
research inputs remain compatible while the runtime boundary is owned by
Polaris.

## Exact behavior retained

- source task types `crossref-doi`, `crossref-search`,
  `semantic-scholar-search`, `deepsec-search`, and `curated-web-search`;
- year/venue/topic scope filtering, optional topic-judge, DOI/reference and
  Semantic Scholar citation expansion, and graph DOT evidence;
- phase 2 PDF-link ranking, shared cache, browser capture, partial/failure
  status, and exact record hashes;
- phase 3 `auto-pass`, `auto-approve`, and `manual-review` with separate
  review-list and non-review artifacts;
- Polaris-owned collection review state, stable review identities, audit
  entries, atomic export, and continuation back into a final collection v2
  handoff;
- analysis methods `iterate`, `batches`, and `propose`, including exact
  observation quotes, paper-type/focus rules, graph actions, checkpoint
  resume, candidate validation, coverage, and revision hashes;
- final analysis output restrictions for approved/not-required claims and
  deterministic Markdown rendering;
- literature report `compress -> outline -> expand`, stable per-case Codex
  sessions, full claim coverage, four reviewer dimensions, revision,
  reviewer-gated Markdown publication, TeX/BibTeX generation, and two-pass
  XeLaTeX PDF rendering.

The fixed `run` path matches the fixed workflow operation:
collection and analysis are followed by report `prepare -> draft -> LaTeX`.
The optional `--report-mode reviewed` path exposes the lower-level review,
revision, publication, and LaTeX operations as one Polaris command.

## Environment

Required for a local run:

```dotenv
POLARIS_LITERATURE_WORKSPACES_ROOT=/path/to/literature-workspaces
POLARIS_LITERATURE_CACHE_ROOT=/path/to/literature-cache
POLARIS_LITERATURE_RUNTIME_MODE=local
```

Put these values in a file selected by
`POLARIS_LITERATURE_ENV_FILE`, or export them in the shell. The loader never
reads a Wanghai environment file. `POLARIS_LITERATURE_RUNTIME_MODE=polaris`
is intentionally fail-closed for direct execution; integrated runs must be
submitted as a Polaris durable job.

Optional provider settings:

- `POLARIS_LITERATURE_CODEX_BIN` / `CODEX_BIN` (the underlying Codex binary)
- `POLARIS_LITERATURE_CODEX_CLI` (optional replacement for the Polaris Codex wrapper)
- `POLARIS_LITERATURE_CODEX_MODEL`
- `POLARIS_LITERATURE_ANALYSIS_MODEL` / `LITERATURE_REVIEW_MODEL`
- `POLARIS_LITERATURE_REPORT_MODEL` / `REPORT_WRITING_MODEL`
- `POLARIS_LITERATURE_REASONING_EFFORT`
- `POLARIS_LITERATURE_REPORT_REASONING_EFFORT`
- `POLARIS_LITERATURE_SEMANTIC_SCHOLAR_API_KEY`
- `POLARIS_LITERATURE_DEEPSEC_API_URL`
- `POLARIS_LITERATURE_CROSSREF_API_URL`
- `POLARIS_LITERATURE_PDF_CACHE`
- `BROWSER_CAMOFOX_URL`, `BROWSER_PROXY_SERVER`,
  `BROWSER_PROXY_USERNAME`, `BROWSER_PROXY_PASSWORD`
- `DISPLAY` when headed PDF capture is enabled

## CLI

Prepare a local execution environment (locked search backends, the social
adapter venv, and browser dependencies):

```sh
bash workflows/literature-review/install-dependencies.sh
```

Use `--skip-browser` or `--skip-external-backends` for a narrower setup. The
script checks out the exact commits in each `backend.lock.json`; it does not
read or write Wanghai configuration.

Inspect the migrated versions and definition:

```sh
pnpm --dir apps/polaris run polaris -- literature-review version
pnpm --dir apps/polaris run polaris -- literature-review tools
pnpm --dir apps/polaris run polaris -- literature-review plan
```

Visualize the complete `LiteratureReviewExecution` trial. The graph includes
all 18 execution nodes, conditional and feedback edges, node retry/action
limits, capabilities, execution policy, budgets, and artifact contracts:

```sh
pnpm --dir apps/polaris run polaris -- literature-review visualize \
  --format png --output literature-review-workflow.png

pnpm --dir apps/polaris run polaris -- literature-review visualize \
  --format pdf --output literature-review-workflow.pdf
```

The output format can also be inferred from a `.png` or `.pdf` output name.
This command is a static definition projection: it does not run the workflow or
call a provider. It requires Graphviz's `dot` executable on `PATH`; set
`POLARIS_LITERATURE_GRAPHVIZ_BIN` when `dot` is installed elsewhere. The
visualizer has no required literature workspace, cache, Codex, browser, or
provider environment variables. `POLARIS_LITERATURE_GRAPHVIZ_BIN` may be
exported directly or supplied in the selected env file; the command also
accepts `--env-file <path>` for an explicit one-off file.

Validate a collection input:

```sh
pnpm --dir apps/polaris run polaris -- literature-review validate \
  --input collection-input.json
```

Run the fixed workflow:

```sh
pnpm --dir apps/polaris run polaris -- literature-review run \
  --input collection-input.json \
  --workspace research-demo \
  --run-id review-001 \
  --network allow \
  --review-mode auto-pass \
  --literature-method iterate \
  --report-mode fixed
```

Use `--report-mode reviewed` to run all four report reviewers and bounded
revision passes before publishing Markdown and rendering PDF.
`--collection-output` resumes from a previously validated collection output
without making source requests. `--dry-run` validates paths and writes only a
planned manifest.

`--env-file <path>` can be supplied on the `run`, `collection-review`,
`complete-collection-review`, and `complete-analysis-review` commands; the
shell loader applies it before the workspace and run identity checks.

The run writes durable local state below:

```text
<workspace>/literature-review/<run-id>/
  intelligence-analysis/
  report-writing/
  runs/
  run.json

<workspace>/data-collections/<collection-id>/
  inputs/  work/  outputs/  runs/
```

## Historical Wanghai import

Historical Wanghai literature data is an offline archive, not an active
workflow workspace. Import it under a tenant- and Vault-qualified archive root
with the Polaris migration command:

```sh
pnpm --dir apps/polaris run migrate:wanghai-literature-data -- \
  --source-root <wanghai-literature-workspace> \
  --archive-root <polaris-archive-root> \
  --tenant-id <tenant-id> \
  --vault-id <vault-id> \
  --workspace-id literature-review \
  --report <migration-report.json>

pnpm --dir apps/polaris run migrate:wanghai-literature-data -- \
  --apply \
  --source-root <wanghai-literature-workspace> \
  --archive-root <polaris-archive-root> \
  --tenant-id <tenant-id> \
  --vault-id <vault-id> \
  --workspace-id literature-review \
  --report <migration-report.json>
```

Run `--verify` after the apply. The importer preserves collection and
workflow history byte-for-byte while excluding browser profiles, virtual
environments, Python caches, incomplete downloads, and symbolic links. It
records those omissions in the report. Imported history is evidence only;
the old Wanghai run state is never presented as a Polaris durable run, and the
source is not removed by the importer.

Use `literature-review status --run-manifest <path>` to inspect that manifest.

For a pending analysis review, submit the Polaris-owned review result and
continue the same run:

```sh
pnpm --dir apps/polaris run polaris -- literature-review \
  complete-analysis-review \
  --run-manifest <workspace>/literature-review/<run-id>/run.json \
  --review-result <review-result.json>
```

This command is local-only. In integrated mode review completion and the
following report stages are submitted as Polaris durable jobs.

To build that result from the generated review list, use the Polaris analysis
review state adapter:

```sh
pnpm --dir apps/polaris run polaris -- literature-review \
  analysis-review bootstrap \
  --run-manifest <workspace>/literature-review/<run-id>/run.json

pnpm --dir apps/polaris run polaris -- literature-review \
  analysis-review save \
  --run-manifest <workspace>/literature-review/<run-id>/run.json \
  --record-id <claim-id> --status approved --note "Reviewed."

pnpm --dir apps/polaris run polaris -- literature-review \
  analysis-review export \
  --run-manifest <workspace>/literature-review/<run-id>/run.json
```

The export is `clue.manual-review.result.v2`, bound to each claim's
`review_key` and `revision_hash`; pass its recorded result path to
`complete-analysis-review`.

For a pending collection review, inspect and update the Polaris-owned queue:

```sh
pnpm --dir apps/polaris run polaris -- literature-review \
  collection-review bootstrap \
  --run-manifest <workspace>/literature-review/<run-id>/run.json

pnpm --dir apps/polaris run polaris -- literature-review \
  collection-review save \
  --run-manifest <workspace>/literature-review/<run-id>/run.json \
  --record-id <record-id> --status approved --note "Reviewed."

pnpm --dir apps/polaris run polaris -- literature-review \
  complete-collection-review \
  --run-manifest <workspace>/literature-review/<run-id>/run.json
```

The collection continuation writes an auditable
`outputs/review-output.json`, atomically replaces the pending collection with
`clue.data-collection.output.v2` status `final`, and resumes analysis. The
standalone `tools/collection-review/clue-collection-review` entrypoint exposes
the same state machine for cell-level diagnostics.

The lower-level migrated CLIs remain available under `tools/` for debugging:

- `tools/data-collection/clue-data-collection`
- `tools/collection-review/clue-collection-review`
- `tools/analysis-review/clue-analysis-review`
- `tools/intelligence-analysis/clue-intelligence-analysis`
- `tools/intelligence-analysis/literature-review/literature-review`
- `tools/report-writing/clue-report-writing`
- `tools/crossref/clue-crossref-cli`
- `tools/semantic-scholar/clue-semantic-scholar-cli`
- `tools/deepsec/clue-deepsec-cli`
- `tools/web-search/clue-web-search-cli`
- `tools/browser/clue-browser`

## Verification

```sh
pnpm --filter polaris-workflow run typecheck
pnpm --filter polaris-workflow run test
pnpm --filter polaris-tools run typecheck
pnpm --filter polaris-tools run test
pnpm --dir apps/polaris run test:literature-review
```

The Polaris test suite uses synthetic fixtures and mocked provider/model calls.
It does not require a Wanghai checkout or contact external services.

`--network deny` rejects a new live collection request and allows only a
validated collection/checkpoint resume. It is a workflow admission flag; a
local Codex or browser process still needs an OS-level disposable execution
cell for hard network isolation. Integrated execution therefore remains
fail-closed until Polaris supplies that cell.

## Execution image boundary

The Polaris server image ships this immutable workflow runtime, common tools,
and the workflow declaration, but
integrated execution remains disabled until a Polaris durable job supplies a
reviewed disposable execution cell. A local run needs Python 3.11+, the Codex
CLI, and XeLaTeX with `xeCJK`; browser-backed PDF capture additionally needs
the dependencies installed by `tools/data-collection/install-dependencies.sh`.
Those dependencies are cell prerequisites, not a hidden Wanghai runtime.
