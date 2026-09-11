# Literature Review: from conversation to an execution run

Status: the `driver=none` host execution slice is implemented. The Portal
composer can submit a SysSec Literature Review brief to the real
collection-to-report runner. The Paseo transcript/draft protocol and the
Vault execution adapter remain design work.

## Execution model

Vault is an execution backend, not a prerequisite for using the work desk.
Polaris resolves one of two simple targets:

| Driver | Execution location | User-facing meaning |
| --- | --- | --- |
| `none` | Polaris host worker | Run without a Vault |
| a configured driver | The selected Vault | Run inside that Vault |

The browser submits a workflow and an optional target. If no driver is chosen,
Polaris uses `driver=none`; if a driver is chosen, Polaris requires the
corresponding Vault admission. There is no automatic fallback from a Vault
failure to host execution.

## The user journey

The work desk should make one research case feel like one continuous piece of
work:

```text
/work
  -> open a work case
  -> open a Paseo transcript
  -> clarify the research brief
  -> propose a structured literature intent
  -> review and confirm the generated input
  -> admit one Polaris durable run
  -> execute the pinned workflow on the host or inside the selected Vault
  -> handle collection / analysis / report review gates
  -> open controlled projections of the execution artifacts
```

The transcript is a drafting surface. It is never an execution authority.
The **Run** action is a separate Polaris action that accepts only a validated,
confirmed draft.

## Four boundaries

| Boundary | Owner | Responsibility |
| --- | --- | --- |
| Conversation | Paseo in the selected execution context | Clarify intent and propose fields |
| Draft | Polaris | Validate, normalize, hash, and version the input |
| Run | Polaris control plane | Admission, lease, queue, review state, audit, recovery |
| Execution adapter | Polaris host or selected Vault | Search, model calls, PDF work, analysis, and report files |

The browser may display a draft and a run projection, but it must not choose a
command, environment variable, filesystem root, credential, or runtime target.

## Input contract

The agent should first produce a small `polaris.literature-intent.v1` draft,
not arbitrary `clue.data-collection.input.v2` JSON. Polaris then compiles that
draft deterministically into the canonical collection input.

The draft contains only user-level research intent:

```json
{
  "schema_version": "polaris.literature-intent.v1",
  "question": "…",
  "decision_context": "…",
  "audience": "…",
  "scope": {
    "time_range": "2022..2026",
    "include": ["…"],
    "exclude": ["…"]
  },
  "source_profile": "crossref-semantic-scholar",
  "max_papers": 40,
  "pdf_links": true,
  "review_mode": "manual-review",
  "literature_method": "iterate",
  "report_mode": "reviewed",
  "report_template": "literature-report"
}
```

`source_profile` is an allowlisted Polaris value. It expands to fixed source
tasks; the agent cannot submit a shell command, URL, API key, arbitrary source
type, or local path. Polaris adds the collection ID, task IDs, evidence policy,
and other defaults, then validates the resulting
`clue.data-collection.input.v2` with the existing runner contract.

The draft lifecycle is:

```text
proposed -> validated -> confirmed -> submitted
                 \\-> rejected
```

Polaris stores the normalized draft, its SHA-256, the source transcript
reference, and the exact compiled input snapshot. A later edit creates a new
draft revision; it never mutates an admitted run.

## Paseo integration

`/work` embeds the existing Paseo web artifact using the versioned embed
protocol. Polaris supplies a scoped context attachment containing:

- the execution target and the current research case ID;
- the `polaris-literature-review` input skill;
- the intent schema and a synthetic example;
- the fixed output filename and the instruction to use the proposal helper.

The skill is installed from the release bundle in the selected execution
context, rather than downloaded from a model-selected source. The agent may
discuss the case in the transcript and use a fixed helper such as:

```text
polaris-literature-input propose \
  --workspace <server-assigned-workspace> \
  --output .polaris/literature/input.json
```

The helper writes only below the server-assigned workspace and applies the
same schema validation as the Portal. In `driver=none` mode the workspace is
host-owned; with a configured driver it is Vault-owned. The Portal never
accepts a free-form browser path.

The first implementation may use a fixed proposal file and an explicit
**Load proposal** button. A later embed-protocol message can make the button
automatic, but it must carry the same draft hash and tenant/execution scope.

## Durable admission

The confirmed draft is submitted by ID, not by path or raw JSON:

```text
POST /api/literature-review/drafts/:draftId/confirm
POST /api/literature-review/runs
```

On the second request Polaris performs one admission transaction:

```text
session and role
  -> tenant scope
  -> host target, or selected driver is currently running
  -> pack/version/digest is verified
  -> draft hash and compiled input still match
  -> capability lease and workspace quota
  -> durable envelope + run + initial event + outbox
```

The run records the immutable input snapshot and the resolved driver. It does
not accept a caller-supplied mode, pack digest, Vault root, or execution
image.

## Execution adapters

Both adapters invoke the canonical
`workflows/literature-review/workflow.py` runner as a fixed, versioned cell
entrypoint. Reimplementing the eighteen Python stages in TypeScript would
create a second Literature Review engine and make the tested local path
diverge from the product path.

### Host adapter (`driver=none`)

The host adapter runs as a child worker of Polaris with a server-assigned
workspace below the Polaris data root. It constructs its working directory,
arguments, environment, credentials, network policy, and output paths
explicitly. It does not load the Portal process environment wholesale.

This mode is the default for local development and front-end/back-end
integration. It is host execution, not an isolated Vault execution.

### Vault adapter

When a configured driver is supplied, the same fixed entrypoint runs inside
the admitted Vault and uses that Vault's mounted workspace and runtime policy.

The cell image/bundle contains:

- the exact Polaris workflow and common tools;
- locked Python dependencies;
- Graphviz and XeLaTeX with the required fonts;
- the browser tool and its pinned browser dependencies; and
- the release-bound skill bundle and a non-interactive cell wrapper.

The bundle is identified by a content digest. In host mode it is read from the
Polaris release tree; in Vault mode it is mounted or copied into the selected
Vault read-only. Run data is written to a scoped host workspace or the Vault's
fixed `/vault/workspaces`, `/vault/cache`, and (where applicable)
`/vault/backups` roots. Provider credentials are resolved by Polaris or the
Vault identity attachment; they never come from the draft or the browser.

The control plane needs one interface, independent of backend mechanics:

```text
admit(run) -> ExecutionHandle
start(handle, fixed-command, scoped-input)
observe(handle) -> progress/checkpoint
cancel(handle)
reconcile(handle) -> terminal result or resumable checkpoint
```

The Vault implementation can initially use a private `docker exec` or a
same-scope disposable child container with explicit data-volume mounts. Pod
and KubeVirt implementations must use their private namespace/guest channel.
No implementation may expose a daemon port, direct container address, SSH
endpoint, or host path to the browser. Unsupported configured drivers fail
closed; `driver=none` is an explicit host choice, not a fallback.

## Progress, review, and recovery

The cell writes a bounded machine-readable status stream and the existing
workflow manifest. Polaris translates stage checkpoints into durable events:

```text
validate
  -> collect
  -> augment
  -> collection review (wait)
  -> freeze
  -> analyze
  -> analysis review (wait)
  -> finalize
  -> report draft / reviewers / revision
  -> Markdown / TeX / BibTeX / PDF
```

At a human gate the adapter exits cleanly with a resumable checkpoint. Polaris
stores the review-list digest and exposes review actions in the run detail
page. An approval writes a validated review result through the same adapter
and queues a fixed continuation command. The host and Vault paths use the same
review state machine.

Long execution cannot use the current short in-process worker lease as its
only protection. The live adapter must heartbeat a durable execution lease,
persist the cell ID and checkpoint before each external call, and reconcile a
stale cell after a Polaris restart. Retry is allowed only when the checkpoint
and request ID prove that the prior effect was not committed. Finalization
requires manifest, artifact, and content-hash verification.

## Artifact projection

The source artifacts stay in the resolved execution workspace. Polaris stores
only bounded metadata and explicitly permitted previews:

- artifact name, kind, size, digest, and stage;
- review and provenance status;
- a redacted Markdown preview when policy permits; and
- a same-origin download handle that rechecks tenant, Vault, run, and lease
  scope.

The Portal never reads an arbitrary path and never labels a synthetic output
as a live report. The implemented host run identifies the pinned workflow
definition, tenant-scoped workspace, input snapshot, and artifact digests. A
future Vault run must additionally identify its execution-cell digest.

## Safety gates before enabling live LR

The live Literature Review binding is ready only after these focused checks
exist and pass:

1. intent schema rejects unknown fields, paths, commands, credentials, and
   oversized values;
2. draft confirmation is tenant/execution scoped and hash-bound;
3. the host and Vault adapters contain the exact pinned workflow/tools and
   pass their respective synthetic runs;
4. host execution uses a scoped workspace and sanitized environment, while
   Vault execution uses explicit mounts, bounded CPU/memory/PIDs, and the
   configured network policy;
5. cancellation, heartbeat, restart recovery, duplicate request
   reconciliation, and artifact hash verification are tested;
6. collection and analysis review can pause and resume through Polaris;
7. credentials and provider errors are redacted from events and previews; and
8. release evidence records the cell digest, profile, rollback switch, and
   focused checks.

The host slice is available as `mode: host` for
`SysSecResearch/LiteratureReview` with `driver=none`. Compatibility flows and
the current Vault branch remain `mode: mock`; no environment-variable shortcut
enables Vault execution.

## Delivery slices

The remaining implementation order is:

1. add the intent schema, deterministic compiler, proposal helper, and draft
   records;
2. mount the Paseo transcript in `/work` and add the scoped skill/context;
3. add a Docker-only pinned Vault adapter using the same fixed runner;
4. complete Polaris-owned collection and analysis review continuation for the
   Portal action;
5. add restart reconciliation and durable execution-cell checkpoints; and
6. enable Vault live execution only after release-profile and recovery
   evidence.

The host path already provides a useful `/work` experience while these
remaining boundaries are added incrementally.
