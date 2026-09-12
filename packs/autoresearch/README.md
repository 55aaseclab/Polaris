# Polaris literature-review workflow

This directory contains only the declarative Polaris literature-review pack:
the DSL declaration, metadata, examples, and skills. Runtime code lives in
the repository-level `tools/` directory. Canonical wire schemas live in the
repository-level `schemas/` directory.

The canonical workflow declaration is
`packs/autoresearch/main.ord`.
The workflow preserves the existing `clue.*.v2` wire contracts so existing
research inputs remain compatible. Polaris loads and executes `main.ord`
through its DSL runtime.

The literature flow uses three explicit boundaries: `literature.collection`
performs collect-and-expand, `pdf.capture` captures one PDF per mapped record,
and `manual.review` is the workflow-level manual gate. There is no
legacy monolithic collection command.

## Exact behavior retained

- source task types `crossref-doi`, `crossref-search`,
  `semantic-scholar-search`, `deepsec-search`, and `curated-web-search`;
- year/venue/topic scope filtering, optional topic-judge, DOI/reference and
  Semantic Scholar citation expansion, and graph DOT evidence;
- phase 2 PDF-link ranking, shared cache, browser capture, partial/failure
  status, and exact record hashes;
- phase 3 `auto-pass`, `auto-approve`, and `manual-review` with separate
  review-list and non-review artifacts;
- Polaris-owned manual-review state, stable review identities, audit
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

The execution trial declares the complete collection, review, analysis, and
report graph. Its port bindings point to the common tools that Polaris owns.

## Environment

Required for a local run:

```dotenv
POLARIS_DATA_ROOT=/path/to/polaris/data
POLARIS_LITERATURE_RUNTIME_MODE=local
```

Host tools share Polaristool's general cache at `$POLARIS_DATA_ROOT/cache`.
`POLARIS_LITERATURE_CACHE_ROOT` is derived from that path when unset. Put
provider credentials in a file selected by `POLARIS_LITERATURE_ENV_FILE`,
or export them in the shell. The loader never reads a Wanghai environment
file. `POLARIS_LITERATURE_RUNTIME_MODE=polaris` is intentionally fail-closed
for direct execution; integrated runs must be submitted as a Polaris durable
job.

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

## Execution

There is no pack-local runner or workflow-specific CLI. Polaris loads
`main.ord`, validates the declaration, and executes the
`LiteratureReview` flow as a durable job. The flow resolves its
port bindings through the common tool inventory and persists its run state in
Polaris.

For local development, submit the `AutoResearch/LiteratureReview` flow through
the Polaris workflow API. The pack itself remains declaration-only.

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

Inspect a historical import with the migration verifier, not a
`literature-review` CLI. There is no `polaris -- literature-review` command.

For a pending analysis or manual review, continue the same durable
Polaris run from the Portal work desk or workflow API. Local tool adapters
under `tools/` remain available for cell-level diagnostics:

- `tools/analysis-review/clue-analysis-review`
- `tools/manual-review/clue-manual-review`

The analysis-review export is `clue.manual-review.result.v2`, bound to each
claim's `review_key` and `revision_hash`. Collection continuation writes an
auditable `outputs/review-output.json`, atomically replaces the pending
collection with `clue.data-collection.output.v2` status `final`, and
resumes analysis.

The lower-level migrated CLIs remain available under `tools/` for debugging:

- `tools/data-collection/clue-data-collection`
- `tools/manual-review/clue-manual-review`
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
