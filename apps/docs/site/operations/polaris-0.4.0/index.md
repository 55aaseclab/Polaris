# Polaris 0.4.0

Status: **shipped as source tag `0.4.0` on 2026-09-11**. The Phase 3-6
deterministic control slice is in the tree. The Portal is the work console,
Domain Packs and workflow definitions live outside every Vault, and each run
is bound to one selected Vault or the Polaris host. Execution remains a
Polaris-owned host or mock host: no real Agent, registry adapter, external
tool, or private surface action is enabled by this slice. An isolated
operator drill exists for the disabled read-only Vault metadata pilot. The
first-party Literature Review pack is `AutoResearch` /
`LiteratureReview`. Ordinary Vault-target workflow runs still use the mock
host.

This page is the authoritative summary of the 0.4.0 implementation state.
It separates the product contract, the current mock boundary, and later live
execution work so a passing UI test cannot be mistaken for proof of an
external side effect.

## Remaining Work

Code is the ground truth. 0.4.0 is the host-workflow source tag on the
shipped `0.3.4` single-host baseline. `CHANGELOG.md`,
`deploy/release-manifest.json`, and `POLARIS_RELEASE_ID` now say `0.4.0`.

### Already in this tag

- Durable mock workflow control: verified packs, WorkEnvelope admission,
  immutable pack pins, Vault capability leases, queue, worker recovery,
  approval, cancellation, retry, event replay, receipts, artifacts, and
  non-executable suggestions.
- `packages/polaris-tools` is the first-party catalog. Polaris derives the
  disabled live action catalog from it.
- Repository packs under `packs/` are discovered as built-in. `pack add`
  installs extra versions under `$POLARIS_DATA_ROOT/control/domain-packs/`.
- `packs/vault-knowledge-health/` is removed. The first-party Portal pack
  is `AutoResearch`.
- `polaris-workflow` has a separately gated `v0.4-trial` surface. It is not
  wired into the ordinary Portal worker.
- Literature Review is the `AutoResearch` / `LiteratureReview` pack at
  `packs/autoresearch/`, with reusable adapters under `tools/`. There is no
  `workflows/literature-review` tree and no `polaris -- literature-review`
  CLI command.
- Ordinary Portal vault-target runs persist `mode: "mock"` and
  `executionDriver: "vault"`. That is the compatibility mock path, not a
  real Vault executor. Host runs (`driver=none`) persist `mode: "host"`.
  Live mode exists only on the operator metadata-admission path.
- Retry requeues the same run id with source `retry` and skips completed
  steps. It does not create a new run for host or Vault-target paths.
- The live tool gateway, metadata executor family, candidate worker route,
  operator admission command, receipt reconciliation, and isolated drill
  exist for `vault.artifact.metadata.read` only.

### Accepted into this tag

- Retry requeues the same run id and skips completed steps for host and
  Vault-target paths. `requeueWorkflowRun` is the only retry path.
- `packs/vault-knowledge-health/` is deleted. `AutoResearch` is the
  first-party Portal pack.
- Skills live next to their tool or pack. The repository-level `skills/`
  tree is gone.
- Ordinary Portal host path: `AutoResearch` / `LiteratureReview` completed
  with the target left as Polaris host.

Leftover `tools/codex` and `tools/report-writing` runner diffs stay out of
this tag.

### Explicitly not 0.4.0

These are later authority boundaries. They do not block the 0.4.0 tag:

- Real `mode: "vault"` execution inside a selected Vault. Postponed to
  [Polaris 0.5.0](../polaris-0.5.0/).
- Additional live executor families beyond the operator-only
  `vault.artifact.metadata.read` pilot.
- AI-assisted workflow generation, a real Vault Host, private-surface
  mutation, or autonomous Agent execution.
- Wiring `v0.4-trial` into the ordinary Portal worker.
- `ops workflow-smoke` as operator-facing proof that a Vault-target path
  is mock-only. That command installs a synthetic pack into a temp data
  root and drives mocked setup, approval, receipts, artifacts, and a
  suggestion. Postpone it to [Polaris 0.5.0](../polaris-0.5.0/) with the
  real `mode: "vault"` executor.

### Must stay true while finishing 0.4.0

- Keep ordinary UI-created setup, provisioning, and Vault-target manual
  or retry runs `mode: "mock"`.
- Keep host runs `mode: "host"`.
- Admit live `vault.artifact.metadata.read` only through
  `ops workflow-admit-live-metadata` with both live flags, release evidence,
  candidate acknowledgement, and a current user-owned runnable Vault.
- Do not add `mode: "vault"` or one adapter per tool in this slice.

### After this tag

- [x] Date `CHANGELOG.md` as `[0.4.0]`.
- [x] Bump `POLARIS_RELEASE_ID` and `deploy/release-manifest.json`.
- [x] Tag `0.4.0`, not `v0.4.0`.
- [ ] Cut a reviewed designated-host candidate only if operators need one.
  A source tag does not require a new m00 promotion.

## Product Boundary

Polaris owns identity, tenant and Vault ownership, role capabilities, setup,
Domain Pack admission, immutable run pins, Vault capability leases, queue
state, event replay, artifacts, policy, and audit. The Portal is a projection
and command surface for those Polaris decisions. Zustand stores browser
projections and optimistic UI state; it is not an authority.

A Domain Pack is a reusable library outside a Vault. Its workflows use the
[Polaris DSL](/polaris/dsl) for entities, typed dataflow, and FFI ports. A
run is the unit that enters a Vault:

```text
Domain Pack outside Vault
  -> Portal selects pack, flow, and Vault
  -> Polaris stores WorkEnvelope + pack digest + capability lease
  -> deterministic queue claims the run
  -> mock Vault Host executes the pinned Polaris DSL program
  -> receipts, events, and artifact projections return to Polaris
  -> Portal renders cards, approval, debug, and results
```

The current mock host runs in the Polaris process and simulates a
Vault-scoped host. It still carries tenant ID, Vault ID, pack digest, and
lease identity in every RPC request. A real `mode: "vault"` adapter is
0.5.0 work. When it arrives, it must preserve that envelope and must not
move workflow authority into a Vault, private surface, or the browser.

The official tool catalog lives in `packages/polaris-tools`. Polaris derives
the disabled live action catalog from that package. There is no second tool
registry or private surface-owned tool list.

## User Stories

The Portal supports three levels of use:

1. Daily use: the user opens the work deck, sees cards, handles cards that
   require approval, and opens a result artifact. Background runs do not
   require the user to watch a page.
2. Provisioning: the first-use flow chooses a Domain Pack as the work scene,
   selects an existing or disposable executable Vault, and enables internal
   workflows. Completing setup persists the choice in Polaris and enqueues
   every enabled workflow.
3. Settings: the user can inspect a Domain Pack's complete internal flow list,
   enable another flow, disable a flow, or change the default Vault. These
   settings update Polaris; they are not browser-only preferences.

The work scene and internal workflow are separate levels. A Domain Pack is
selected first; a flow is selected within that pack. The Portal never
hardcodes a pack-specific pack, flow, or role. Roles and workflow groups come
from installed pack metadata and Polaris policy.

## Storage And Runtime

Verified packs are installed by the Polaris CLI at:

```text
$POLARIS_DATA_ROOT/control/domain-packs/<domain>/<version>/
```

Each installation contains immutable [Polaris DSL](/polaris/dsl) source and
a manifest with a SHA-256 digest. `pack add` validates source and imports
before the atomic write; `pack list` detects drift; `pack remove` removes
only the requested version. The authenticated `GET /api/domain-packs`
projection exposes verified packs, flows, capabilities, and approval
metadata. Language and pack IR live on the Polaris DSL page.

The control store persists setup, envelopes, capability leases, runs, events,
outbox items, effect receipts, artifacts, and non-executable suggestions in
the existing durable control database. The workflow tables do not create a
second control plane.

After setup or successful Vault provisioning, each enabled flow gets one
deduplicated provisioning run. A run can be `queued`, `running`, `waiting`,
`succeeded`, `failed`, or `cancelled`. A waiting run releases its worker
lease, so approval can be claimed by the next worker pass. A cancelled run
cannot be claimed again; retry requeues the same run with source `retry`
and skips completed steps.

## Phase Status

### Phase 0: Portal Contract And UI

Implemented. React, shadcn/ui, and Zustand cover Domain Pack discovery,
internal flow selection, existing/disposable Vault selection, submission,
cards, observation, approval, cancellation, retry, artifact opening, and the
Debug view. The Portal API is same-origin and user-scoped.

### Phase 1: Mocked Vertical Slice

Implemented and superseded as the production route by the durable control
service. The original deterministic journey remains as a compatibility test
fixture. Production workflow routes now use `WorkflowControlService`, so the
mock is no longer an in-memory source of run truth.

### Phase 2: Real Pack And Vault Projections

Implemented. Packs come from the verified CLI-managed
[Polaris DSL](/polaris/dsl) store. Vaults come from the current user-owned
Polaris Vault projection. `status`, `canRun`, and `availabilityReason` remain
server-derived; the Portal does not invent a second Vault lifecycle.

### Phase 3: Durable Admission And Run State

Implemented. Setup persistence, WorkEnvelope admission, immutable pack
digest pinning, Vault capability leases, durable runs, deterministic worker
claims, tenant isolation, approval, cancellation, retry, replay cursors, and
restart recovery are in the Polaris control store. Run creation, its
envelope, its lease, and its initial event commit in one SQLite transaction.

### Phase 4: Generic FFI And Mock Vault Host

Implemented as a mock-only boundary. The versioned RPC envelope carries the
run, tenant, Vault, pack pin, capability lease, call, input, mode, and trace
identity. The [Polaris DSL](/polaris/dsl) parser supports explicit
`builtin manual.review`; the generic built-in registry defines the
interface, while a Domain Pack port declares where it is used. The mock host
records deterministic receipts and produces synthetic artifacts. No real
tool package is installed into a Vault.

### Phase 5: Deterministic Guarded Automation

Implemented in mock mode. Completing setup or provisioning enqueues every
enabled flow; the worker rechecks Vault admission and the capability lease
before running; policy records `mock` mode and the reasons for admission;
lease revocation and failed Vault admission stop execution. All effects are
synthetic. Live external actions, live AI, arbitrary code, and automatic
high-impact operations remain disabled.

### Phase 6: Draft And Suggestion Boundary

Implemented as a non-executable contract. A successful run may produce a
durable `suggested` draft containing its pinned pack, flow, receipt references,
run ID, and event evidence. Suggestions are not enabled, published, retried,
or executable. AI-assisted workflow generation is intentionally postponed;
the current draft is deterministic metadata derived from a confirmed run.

## FFI And Ownership

FFI calls are declared inside [Polaris DSL](/polaris/dsl) workflow
definitions. Port syntax, built-in interfaces, and the RPC wire contract
live on that page.

The implementation locations are fixed:

| Location | Responsibility |
| --- | --- |
| Domain Pack repository | `.ord` declarations, flow composition, role/group metadata, and pack tests |
| `packages/polaris-tools` | Official first-party tool manifests, portal rows, mock receipts, and disabled live gates |
| `packages/polaris-workflow` | AST, parser, compiler, built-in interfaces, RPC wire types, and admission validation |
| Polaris app | verified pack storage, policy, leases, queue, mock host, receipts, artifacts, and Portal API |
| private surface | private Vault-scoped surface adapter only; no scheduler, pack registry, or run authority |
| Vault | selected execution cell; receives a capability-limited envelope when a live adapter exists |

`manual.review` is an interface, not domain logic. A pack instantiates it by
declaring a port with the built-in binding and calling that port from a flow.
Polaris owns the approval state transition; the pack owns the review's
business fields and presentation metadata.

## Security, Resilience, And Concurrency

- Execution admission requires a verified source digest and a current lease
  whose pack digest and Vault ID match the request. The RPC layer repeats this
  check before a host responds.
- Every run is tenant-scoped and Vault-scoped. Setup, runs, events, packs, and
  Vault projections reject cross-tenant access.
- Envelope, lease, run, and initial event are atomic. Event append also writes
  the outbox record in the same transaction.
- SQLite WAL plus worker ownership provides the single-host queue. Expired
  worker leases are reclaimed. A `waiting` run releases ownership, so
  approval cannot be stranded behind the previous worker.
- Dedupe keys prevent duplicate provisioning runs. Effect receipts are
  idempotent by request ID. Artifact content is hashed and redaction metadata
  is persisted with it.
- Vault admission is rechecked immediately before execution. Revoking a lease,
  stopping a Vault, or changing the selected driver prevents the next effect.
- The current implementation has no external side effects. Live actions
  require a separate receipt, reconciliation, budget, kill-switch, and
  deployment review.

## Development And Operations

Focused source checks are:

```text
pnpm --filter polaris-workflow run typecheck
pnpm --filter polaris-workflow test
pnpm --filter polaris-tools run typecheck
pnpm --filter polaris-tools test
pnpm --filter polaris exec tsc --noEmit
pnpm --filter polaris exec tsx --test tests/polaris-control-store.test.ts
pnpm --filter polaris exec tsx --test tests/polaris-workflow-control.test.ts
pnpm --filter polaris exec tsx --test tests/polaris-workflow-live-boundary.test.ts
pnpm --filter polaris exec tsx --test tests/polaris-workflow-live-vault-adapter.test.ts
pnpm --filter polaris exec tsx --test tests/polaris-workflow-live-worker-binding.test.ts
pnpm --filter polaris exec tsx --test tests/polaris-workflow-live-metadata-drill.test.ts
pnpm --filter polaris run test:domain-packs
pnpm --filter polaris exec tsx --test tests/polaris-portal.test.ts
pnpm --filter polaris-portal test
git diff --check
```

A deployment continues to use the 0.3.4 single-host boundary: Polaris is the
only control plane, private surface remains private behind the Gateway, and the
existing Vault Management runtime and data attachments remain authoritative.
The 0.4.0 workflow tables use the same durable control store; no new public
port, private surface listener, or second scheduler is introduced.

## Implementation Evidence

### Polaris literature-review migration

The migrated implementation preserves the existing versioned `clue.*` input
and output contracts. Its local durable layout keeps collection artifacts under
`<workspace>/data-collections/<collection-id>/` and run artifacts under
`<workspace>/literature-review/<run-id>/`. The public entry point is the
`AutoResearch` / `LiteratureReview` Domain Pack from the Portal work desk
or the workflow API. There is no `polaris -- literature-review` command.

The collection path retains the fixed phases collection → citation/reference
expansion → augmentation/PDF capture → review. A manual collection review is
owned by the Polaris bundle: decisions use stable record identities, are
atomically persisted with an audit trail, export
`clue.data-collection.review-output.v1`, and continue only after a final
`clue.data-collection.output.v2` handoff is reconstructed. Analysis review uses
the same pending/resume boundary. Integrated mode remains fail-closed until a
Polaris durable job provides a reviewed disposable execution cell.

The focused Polaris checks run the migrated Python and browser tests, the
synthetic collection → analysis → report lifecycle, both review continuations,
the Codex wrapper guard, and the no-private surface-dependency assertion. They use only
synthetic fixtures and do not call private surface or external providers.

| Commit | Scope | Focused checks |
| --- | --- | --- |
| `17a6519` | Durable mock workflow control: setup, WorkEnvelope admission, pack digest pinning, Vault capability leases, queue, approval, retry, receipts, artifacts, suggestions, Portal projection, and Debug view. | `polaris-workflow` typecheck/test; Polaris TypeScript; `polaris-control-store`, `polaris-workflow-control`, `polaris-portal`; `polaris-portal` tests; `git diff --check`; docs check |
| `229e91d` | Disabled live adapter and action catalog boundary. The evaluator repeats FFI admission and fails closed unless deployment flag, reconciliation, budget, kill-switch, audit, rollback, deployment evidence, and action enablement are all present. It is not wired into the worker. | Polaris TypeScript; `polaris-workflow-live-boundary`; `git diff --check` |
| `6ba4965` | Disabled read-only Vault metadata pilot. It reuses the live boundary, never calls the reader before admission, and only projects bounded artifact metadata when a separately reviewed live action is enabled. It remains source-level only. | Polaris TypeScript; `polaris-workflow-live-vault-adapter`; `git diff --check` |
| `9723855` | Default Polaris-owned metadata reader for the disabled pilot. It accepts only the Vault metadata action, requires the request tenant to own the Vault, requires a running selected driver with matching config, and projects only cached Polaris Vault status/evolution metadata. It remains unwired from the worker. | Polaris TypeScript; `polaris-workflow-live-vault-adapter`; `git diff --check` |
| `aeb48ad` | Durable audit and receipt reconciliation for the disabled read-only metadata pilot. It records no evidence before admission, reconciles duplicate metadata request IDs to one receipt and audit event, and persists admitted read failures as failed evidence. It remains unwired from the worker. | Polaris TypeScript; `polaris-workflow-live-boundary` and `polaris-workflow-live-vault-adapter`; `git diff --check` |
| `ceb8d20` | Source-level worker-binding precondition evaluator for the disabled metadata pilot. It requires reviewed read-only action metadata, the current `0.3.0-single-host` profile, timeout and retry bounds, one-worker budget accounting, fail-closed kill-switch checks, durable evidence, rollback, and focused deployment checks. It does not wire the worker. | Polaris TypeScript; `polaris-workflow-live-boundary` and `polaris-workflow-live-vault-adapter`; `git diff --check` |
| `6b06ea4` | Disabled worker-binding helper for the metadata pilot. It remains outside the production workflow worker, requires separate adapter and worker flags, requires a candidate action catalog, enforces one in-process live read, bounds attempts with abortable timeouts, retries only admitted read failures, reconciles one final receipt/audit result, and models rollback by disabling the worker flag without deleting evidence. | Polaris TypeScript; `polaris-workflow-live-boundary`, `polaris-workflow-live-vault-adapter`, and `polaris-workflow-live-worker-binding`; `git diff --check` |
| `b239520` | Mocked workflow smoke runner. `ops workflow-smoke` installs a synthetic pack into an isolated temp data root, drives setup, approval, receipts, artifacts, and suggestion creation, and exits with a machine-readable summary that proves only mocked FFI/tools ran. | `pnpm --filter polaris run smoke:workflow`; `polaris-workflow-smoke.test.ts`; `git diff --check` |
| `b239520` | First-party shared catalog. `packages/polaris-tools` is the canonical Common tool manifest source; Polaris derives the disabled live action catalog with Common tools plus Domain Pack flow-tool calls, without credential values, execution URLs, console state, publisher APIs, or live tool runners. | `polaris-tools` typecheck/test; `polaris-workflow-live-boundary`; `polaris-portal` tests; `git diff --check` |
| `4393989` | Isolated operator drill for the disabled metadata pilot. `ops workflow-live-metadata-drill` requires both live flags and `--candidate-live-enabled`, creates a synthetic Polaris run, invokes the candidate worker helper, reads bounded Polaris-owned Vault status metadata, records receipt/audit evidence, and closes the drill run. It does not wire ordinary workflows to the live adapter. | `pnpm --filter polaris run check`; `polaris-workflow-live-boundary`, `polaris-workflow-live-vault-adapter`, `polaris-workflow-live-worker-binding`, and `polaris-workflow-live-metadata-drill`; `pnpm --filter polaris run smoke:workflow`; `git diff --check` |
| `65b58d5` | Candidate ordinary-worker wiring for `vault.artifact.metadata.read`. The workflow runtime now has an async FFI path, the Polaris worker routes only durable live-policy `ArtifactMetadata@1.0.0` read calls through the candidate helper, requires both live flags and focused deployment evidence, writes no duplicate receipts, and fails closed without calling the reader when flags are unset. UI-created manual and provisioning runs remain mock-policy runs. | `polaris-workflow` typecheck/test; `polaris-workflow-control`, `polaris-workflow-live-boundary`, `polaris-workflow-live-vault-adapter`, `polaris-workflow-live-worker-binding`, and `polaris-workflow-live-metadata-drill`; `pnpm --filter polaris run check`; `pnpm --filter polaris run smoke:workflow`; `git diff --check` |
| `9270f27` | Operator admission path for the metadata pilot. `ops workflow-admit-live-metadata` requires operator identity, release id, both live flags, explicit candidate acknowledgement, a current user-owned runnable Vault, required flow inputs, an immutable installed pack digest, and exactly one compiled `ArtifactMetadata@1.0.0` read call before creating a durable `mode: "live"` run and `workflow.live.admit` audit event. Private surface, setup provisioning, and ordinary UI-created workflow runs remain non-execution surfaces. | `pnpm --filter polaris run check`; `polaris-workflow-control`, `polaris-workflow-live-boundary`, `polaris-workflow-live-vault-adapter`, `polaris-workflow-live-worker-binding`, and `polaris-workflow-live-metadata-drill`; `pnpm --filter polaris run smoke:workflow`; `git diff --check` |
| `9a1ad1c` | Generic live tool gateway for the metadata pilot. `workflow-live-tool-gateway` owns common admission dispatch, executor-family matching, abort-signal propagation, receipt output, audit metadata, and failed admitted evidence recording. `vault.artifact.metadata.read` is now the first `polaris.projection` tool definition; the public portal shows executor family wording, and no additional live executable surface was added. | `pnpm --filter polaris run check`; `polaris-workflow-live-tool-gateway`, `polaris-workflow-live-boundary`, `polaris-workflow-live-vault-adapter`, `polaris-workflow-live-worker-binding`, `polaris-workflow-live-metadata-drill`, `polaris-workflow-control`, and `polaris-portal`; `pnpm --filter polaris-tools test`; `pnpm --filter polaris run smoke:workflow`; `git diff --check` |
| `2b5ec6c` | Historical pack-flow portal UX for a later-removed Vault Knowledge Health pack. The current first-party business pack is `AutoResearch`. | `pnpm --filter polaris-tools test`; `pnpm --filter polaris run check`; `pnpm --filter polaris run test:domain-packs`; `pnpm --filter polaris run smoke:workflow`; `git diff --check` |
| `f284e9f` | Adds the separately versioned `v0.4-trial` AST/parser/compiler/runtime, bounded CVE-Genie graph, and the Polaris-owned literature-review workflow. Literature Review now lives in `packs/autoresearch/`; reusable implementations live once under `tools/`. v0.3 remains the default, and no trial or literature execution is wired to ordinary Portal live tools. | `polaris-workflow` typecheck/test; `polaris-tools` typecheck/test; `polaris` check; `polaris` test:smoke; `polaris` test:domain-packs; `polaris` test:literature-review; workflow smoke; final Docker image static-plan smoke; `git diff --check`; docs check |
| `1b05212` | Imports private surface Literature Review history into a tenant/vault-scoped Polaris historical archive. The copy is byte/hash verified, marked historical-only, and does not create a new durable run. | Polaris Literature Review `18/18`; migration tests `3/3`; receipt verification `valid=true` |
| `2922a4e` | Moves private surface business tools, contracts, and business-core implementation into Polaris-owned tool and business-core locations. | Business tool contract checks `5/5`; business-core typecheck/tests; focused path and schema checks |
| `044cfac` | Moves the private surface business Portal surface into the Polaris business Portal while retaining the private surface gateway boundary. | Business Portal typecheck/tests; gateway and mutation-policy checks |
| `5864780` | Moves private surface skills, coursework, and third-party integrations into Polaris-owned skill/domain-pack locations. Third-party source commits remain independently pinned. | Skill/domain-pack checks; third-party submodule pointer audit; `git diff --check` |
| `90f81b5` | Removes the remaining legacy private surface package reference from migrated Polaris components. | Polaris tool typecheck/tests; source reference audit |
| `e45e728` | Records the final private surface migration boundary in the Polaris changelog: workflow execution, tools, skills, and third-party content are Polaris-owned; private surface remains a private surface. | Polaris changelog review; `git diff --check` |
| `4de4fc5` (private surface) | Prepares private surface for archive: deletes migrated tools, skills, third-party submodules, tool-only schemas, and the tools image path; keeps the Portal, workspace/status/doctor surface, retained schemas, and fixed-mount adapters. | private surface `ci-local.sh`, 39 workflow tests, 120 Portal tests, core tests, backup/local-stack/image checks, Docker build, and archive-boundary regression |

These are source-level implementation checks. They are not deployed evidence,
production approval, or proof of external side effects.

## Related Documents

- [WorkEnvelope and workflow plan](./work-envelope-and-workflow-plan.md)
- [Dynamic workflow runtime](./dynamic-workflow-runtime.md)
- [Polaris DSL](../../polaris/dsl.md)
- [Polaris Portal](../../polaris/polaris-portal.md)
- [Vault Management](../../polaris/vault-management.md)
- [Polaris Gateway](../../polaris/gateway.md)
- [Polaris 0.3.4](../polaris-0.3.4/)

## Release Boundary

The Phase 3-6 slice is source-complete when the focused checks above pass
and the Portal contract remains unchanged. 0.4.0 is a host-workflow
release, not a live Agent release and not a real Vault-executor release.
The ordinary Portal path can run `AutoResearch` / `LiteratureReview` as a
host run. A selected Vault target remains `mode: "mock"` until 0.5.0. Live
`vault.artifact.metadata.read` remains behind the operator admission path
and both deployment flags. AI-assisted workflow generation remains later
work.
