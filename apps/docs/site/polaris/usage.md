# Polaris Usage

This page describes the current operator path through the Polaris Portal at
`/work`.

The Portal is the control surface for identity, Vault ownership, workflow
admission, durable run state, approval, audit, and artifact projections. It is
not a second execution engine.

## Execution targets

The default execution target is the Polaris host. No Vault is required for a
host run: `driver=none` sends the admitted workflow to the host worker.

A Vault is an optional target in 0.4.0, not a real executor. When a concrete
Vault is selected, Polaris still performs ownership and readiness checks,
then runs the compatibility mock host and persists `mode: "mock"`. A real
`mode: "vault"` executor is [Polaris 0.5.0](/operations/polaris-0.5.0/)
work. The Portal does not require users to understand this distinction for
ordinary work.

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
target, input snapshot, approval/cancel/retry actions, and artifacts.

The work desk is safe to leave while a run is active. Returning to the page
reconstructs its state from Polaris rather than from browser memory.

## Literature Review from `/work`

Literature Review is the first-party `AutoResearch` pack in
`packs/autoresearch/`. It is a durable Polaris workflow, not a synthetic
Portal card and not a separate CLI. To run it:

1. Open `/work` and select **新建工作**.
2. Choose **autoresearch** and **Literature Review**.
3. Leave the execution target as **Polaris host（无 Vault）** for a host run.
4. Enter the research question and submit the work.
5. Open the resulting card. It returns immediately with a queued or running
   projection while Polaris executes collection, analysis, and report writing.
6. When the run completes, open the projected Markdown or PDF artifact from
   the run-detail page.

No Vault is needed for the host path. To test the optional Vault branch,
choose **Vault（使用已运行的 Vault）** in step 3 and select a Vault reported
as `running`.

This verifies Domain Pack discovery from `packs/`, host admission, immutable
pack pinning, durable leasing, asynchronous queue processing, replayable
events, and Literature Review artifact projection. A Vault target
additionally verifies Vault ownership and readiness admission.

## Current execution boundary

`AutoResearch/LiteratureReview` with `driver=none` is a host run. Polaris
persists `mode: "host"` and executes the compiled pack through the host
tool dispatcher. Collection, analysis, and report adapters live under
`tools/`. There is no `workflows/literature-review` tree and no
`polaris -- literature-review` command.

A Vault-target Literature Review run remains the compatibility mock path.
Those runs persist `mode: "mock"` and must not be interpreted as real
Vault execution. Real `mode: "vault"` is postponed to
[Polaris 0.5.0](/operations/polaris-0.5.0/). Live
`vault.artifact.metadata.read` exists only on the operator admission path.

Retry of a failed or cancelled run requeues the same run id and skips
completed steps. It does not create a new run for host or Vault-target
paths.

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
