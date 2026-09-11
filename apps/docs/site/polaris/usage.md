# Polaris Usage

This page describes the current operator path through the Polaris Portal at
`/work`.

The Portal is the control surface for identity, Vault ownership, workflow
admission, durable run state, approval, audit, and artifact projections. It is
not a second execution engine.

## Execution targets

The default execution target is the Polaris host. No Vault is required for a
host run: `driver=none` sends the admitted workflow to the host worker.

A Vault is an optional execution backend. When a concrete Vault driver is
selected, Polaris performs the normal ownership and readiness checks and runs
the workflow there. The Portal does not require users to understand this
distinction for ordinary work.

## Optional Vault setup

Use this path when the workflow needs to execute inside an isolated Vault whose
selected driver is reported as `running`.

1. Open `/hosts`.
2. Create a Vault, choose the applicable product line, and wait until its
   status is `running`.
3. Open `/setup` from the top navigation.
4. Choose one Domain Pack as the work scene.
5. Choose the running Vault as the execution target.
6. Enable only the flows that should be available in this work scene.
7. Select **完成设置**.

Setup is persisted by Polaris. Completing it enqueues one provisioning run for
each enabled flow. An unavailable Vault is rejected by the server; the browser
does not start or repair a Vault implicitly.

## Daily work-desk loop

Open `/work` directly for a host run, or after setup for a Vault run. The work
desk shows the server-owned run cards:

- **排队中** — the run has been admitted and is waiting for a worker;
- **运行中** — the worker is processing it;
- **等你确认** — a human approval transition is required;
- **已完成** — the projected artifact can be opened;
- **失败** or **已取消** — inspect the run and retry when appropriate.

Use `/work/runs/:runId` for the run timeline, pinned Domain Pack and execution
target, input snapshot, approval/cancel/retry actions, and artifacts. Use
`/debug` to inspect the same durable run projection and its ordered event
stream.

The work desk is safe to leave while a run is active. Returning to the page
reconstructs its state from Polaris rather than from browser memory.

## Literature Review from `/work`

The Literature Review host path is a real Polaris workflow, not a synthetic
Portal card. To run it:

1. Open `/work` and select **新建工作**.
2. Choose **Systems Security Research** and **文献综述**
   (`LiteratureReview`).
3. Leave the execution target as **Polaris host（无 Vault）**.
4. Enter the research question and submit the work.
5. Open the resulting card. It returns immediately with a queued or running
   projection while Polaris executes collection, analysis, and report writing.
6. When the run completes, open `report.md` or `report.pdf` from the run-detail
   page. `/debug` shows the same durable run and stage events.

No Vault is needed for this path. To test the optional Vault branch, choose
**Vault（使用已运行的 Vault）** in step 3 and select a Vault reported as
`running`.

This verifies Domain Pack discovery, host admission, immutable pack pinning,
durable leasing, asynchronous queue processing, replayable events, and real
Literature Review artifact projection. A Vault target additionally verifies
Vault ownership and readiness admission.

## Current execution boundary

For `SysSecResearch/LiteratureReview` with `driver=none`, Polaris runs the
versioned host adapter in
`workflows/literature-review/polaris-literature-review`. Its collection,
analysis, Markdown, TeX/BibTeX, and PDF outputs are projected from the scoped
host workspace into the durable run.

Other Domain Pack flows still use the deterministic workflow FFI path, and the
current Vault Literature Review branch remains the compatibility mock path.
Those runs are labeled `mode: "mock"` and must not be interpreted as real
external execution.

## Real Polaris Literature Review

The same 18-node Literature Review implementation used by the host adapter
lives in `workflows/literature-review/`. Its local execution path is documented
in that directory's `README.md` and uses a versioned
`clue.data-collection.input.v2` file.

The quality-oriented local path is:

```bash
export POLARIS_LITERATURE_WORKSPACES_ROOT=.runtime/literature-workspaces
export POLARIS_LITERATURE_CACHE_ROOT=.runtime/literature-cache
export POLARIS_LITERATURE_RUNTIME_MODE=local

pnpm --dir apps/polaris run polaris -- literature-review validate \
  --input <collection-input.json>

pnpm --dir apps/polaris run polaris -- literature-review run \
  --input <collection-input.json> \
  --workspace <workspace-id> \
  --run-id <run-id> \
  --network allow \
  --review-mode manual-review \
  --literature-method iterate \
  --report-mode reviewed
```

That path performs collection, citation/reference expansion, PDF augmentation,
collection review, evidence-bound claim analysis, analysis review, report
review, Markdown publication, TeX/BibTeX generation, and PDF rendering.

`POLARIS_LITERATURE_RUNTIME_MODE=polaris` is intentionally fail-closed for
direct CLI execution. An integrated live run must eventually be submitted as
a Polaris durable job backed by a reviewed disposable execution cell.

## Conversation boundary

The intended user flow is:

```text
/work composer
  → structured Literature Review input
  → Polaris durable admission
  → host executor (`driver=none`) or selected Vault executor
  → collection review
  → analysis review
  → report review
  → Markdown / TeX / BibTeX / PDF artifacts
```

The current composer collects the brief directly. A future Paseo transcript can
produce the same validated draft, but it must remain a drafting surface; only
Polaris durable admission can start the run.

The proposed live boundary is documented in
[Literature Review: from conversation to an execution run](./literature-review-live-design.md).
