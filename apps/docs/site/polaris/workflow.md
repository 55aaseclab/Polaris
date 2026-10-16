# Polaris Workflow

Polaris workflow is the durable path from a declared Domain Pack to a run with
receipts and evidence. The DSL is the language surface. This page is the
workflow reference: how to run a DSL, how a DSL is defined, which engine
executes it, worked examples, the CLI, and where the code and documentation
live.

## Run a DSL from the Polaris command line

The Polaris CLI entry point is:

```bash
pnpm --dir apps/polaris run polaris -- <command> ...
```

This command does not auto-load `.env.dev`. Load your env first when you need
local development data.

### Install and verify a pack

A DSL is always run as part of an installed Domain Pack:

```bash
pnpm --dir apps/polaris run polaris -- pack add <file.ord|pack-directory>
pnpm --dir apps/polaris run polaris -- pack list
pnpm --dir apps/polaris run polaris -- pack remove <domain> [--version <x.y.z>]
```

`pack add` runs the same `parse -> resolve -> validate` sequence as the
engine before the atomic install. First-party packs under `packs/` and
third-party packs under `third_party/` are discovered automatically and do
not need `pack add`.

### Run a flow

There is no `polaris -- run <file.ord>` or `polaris -- literature-review`
command. A run is an admitted object, not a process spawn. Four paths exist:

1. Portal work desk at `/work`, `/setup`, and `/settings/workflows`.
2. Workflow API against the Polaris service:

   ```bash
   curl -X POST https://your-domain.example/api/workflow-runs \
     -H "Content-Type: application/json" \
     --cookie "<portal-session>" \
     -d '{"packId":"autoresearch","flowId":"LiteratureReview","driver":"none","values":"question=..."}'
   ```

3. Operator live-metadata admission (the only live-policy path):

   ```bash
   POLARIS_WORKFLOW_LIVE_ADAPTER=enabled \
   POLARIS_WORKFLOW_LIVE_WORKER_BINDING=enabled \
   pnpm --dir apps/polaris run polaris -- ops workflow-admit-live-metadata \
     --tenant <userId> --vault <vault> --pack <packId> --flow <flowId> \
     --operator <operatorId> --candidate-live-enabled --wait --json
   ```

4. Mock-only end-to-end drill: `ops workflow-smoke`. It stays in the tree as
   a Vault-target drill; it is not a release gate.

The run request body accepts `packId`, `flowId`, optional `vaultId`, optional
`driver`, a `values` string of `key=value` pairs, and an optional `scenario`.
`driver=none` sends the run to the host worker and cannot be combined with
`vaultId`. `driver=vault` requires a `vaultId` and executes inside an isolated
Vault. Ordinary UI admission creates `mode: "mock"` runs; host admission
creates `mode: "host"` runs; only the operator path above admits
`mode: "live"`.

A durable run moves through a small state machine:

```text
queued -> running -> succeeded
              |-> waiting --human approve--> running
              |-> failed  --retry---------> same queued run
queued/running/waiting --cancel----------------> cancelled
```

The run keeps its pinned pack version and digest across every transition.
Retry requeues the same run id and keeps completed step results.

Polaris decides what the current user can see, suggest, approve, or execute.
Membership does not imply execution:

```text
observer   -> read pack and scoped evidence
proposer   -> create a disabled draft
approver   -> approve or reject a draft or run action
executor   -> run an already pinned definition with a current lease
reconciler -> inspect receipts and failures
```

## DSL definition

Hardcoding one domain into the product does not scale. Writing each step as
a command and argument list also fails: the pack becomes a shell script,
later steps cannot check their inputs, and there is no record of what a step
may touch. The DSL keeps the customization-versus-generality contract:
customize by publishing a pack, stay general by using one DSL for every
pack. The split is:

```text
DSL    -> what the work means, how data moves, which capabilities it may use
Pack   -> one versioned domain: entities, flows, ports, labels
Host   -> who implements a port, where artifacts land, how a call is bound
Polaris -> who may install, pin, lease, run, approve, and keep evidence
```

A durable business system moves value across three worlds: meaning
(entity, state, event), computation (input, uses, out), and the outside
world (Tool = FFI port). The language answers a different question in each
world.

A Domain Pack file is one `.ord`, or a directory whose `main.ord` is the
declaration. The file header names the pack:

```text
dsl version "0.4"          # optional; the default surface is 0.3
domain AutoResearch version "0.1.0"
title "autoresearch"
description "..."
category "Research"
accent "green"
```

The language keeps a small kernel of orthogonal forms. Industry words stay in
pack content and never become keywords. Identifiers are Unicode, so
`ReserveStock`, `任务单`, and `分拣臂` are all valid.

| Construct | World | Role |
| --- | --- | --- |
| `domain` | Pack | Versioned business universe |
| `module` | Meaning | Portal workflow group / role grouping |
| `enum` / `entity` | Meaning | Vocabulary and record shape |
| `port` | FFI | Capability contract with `in`, `out`, and `effect` |
| `flow` | Meaning + computation | One selectable business transaction |
| `input` / `output` | Computation | Flow contract and Portal form schema |
| `require` | Meaning | Guard before a run advances |
| `needs` | FFI | Capability ports the Host must provide |
| `steps` | Computation | Named context transforms; optional `call` |
| `transition` / `emit` | Meaning | State change and domain event |
| `pipeline` | Computation | Optional metadata for a main path of flows |
| `import` | Pack | Cross-pack enum, entity, and port reuse |
| `ui` | Presentation | Optional form projection; not semantic core |

A `port` is a typed contract, not an implementation:

```text
port literature.collection version "1.0.0" {
  in { question: String, keywordPlanRef: String }
  out { collectionOutputRef: String, collectionCount: Number }
  effect ffi
  binding { tool "literature.collection" }
}
```

Effects are `pure`, `read`, `write`, `ffi`, `human`, or `time`:

| Effect | Meaning | Example |
| --- | --- | --- |
| `pure` | Touches only the context | Validation, assembly, mapping |
| `read` | Reads the outside world | Query an inventory port |
| `write` | Writes the outside world | Persist, send a message |
| `ffi` | Generic external call | Collection, analysis CLI |
| `human` | Waits for a person | Approval, human gate |
| `time` | Delay or schedule | Due date, SLA |

A port may bind a Polaris built-in (`builtin manual.review`) or a Host
tool-inventory ID. Those names remain symbols; the Host decides how the call
runs. Built-ins are generic Polaris interfaces, not domain-specific tool
bodies: a new built-in needs a versioned input and output contract, risk
class, policy requirement, receipt model, and mock implementation. A pack
cannot bind a built-in to an arbitrary executable or endpoint.

A flow is a typed transaction:

```text
flow = require + input + steps + transition/emit + output
step = uses + optional call + output
```

No `call` means a pure computation step. A `call` is an effect step: `uses`
map to `port.in` and `output` comes from `port.out`. Reading the outside
world requires a port; implicit global files are not allowed.

`import` composes packs without merging their flows. It merges enums,
entities, and ports; `as Alias` qualifies symbols as `Alias.Name`; a bare
port name selects the highest installed version; constraints are exact,
`1.2` (treated as `^`), or `^1.2.0`; imported packs must already be
installed.

The surface defaults to **v0.3**. **v0.4** adds executable `map` steps:
a map resolves a collection, invokes its port once per item, and
materializes the item/output pairs as a new collection artifact. The parser
rejects the removed `trial` syntax and unknown language versions.
`domain.version` is the pack version, separate from the language version.

Executable paths, Docker and environment names, prompt text, artifact hashes,
and renderer names stay out of the kernel.

Execution policies such as conditional routing, feedback, retry, and durable
checkpointing are intentionally deferred from the current DSL surface.
AI-assisted workflow generation is not implemented. A model may later propose
a fragment or AST, but Polaris must still validate it, dry-run it without
effects, require human publication, and issue a new immutable pack version
before any run can use it.

### Design principles

1. Industry words never enter the kernel; only `entity`, `flow`, `port` and
   the other forms above do.
2. Tool is a port, not a step field.
3. Every datum has a name; `uses` and `out` are visible, no hidden globals.
4. Every effect is declared; `call` / `human` / `write` are auditable.
5. Every binding is replaceable; the same description runs on many Hosts.
6. Configuration is not language; paths, secrets, and replica counts stay in
   the binding.
7. UI is a projection; rendering can change without changing semantics.
8. AI writes models, not arbitrary code; it generates `.ord` and validates,
   it does not emit ungovernable scripts.

### Implementation status

| Capability | Status |
| --- | --- |
| Parser / Validator / Interpreter / Compiler | Implemented |
| `entity` · `flow` · `input` · `steps.uses/output` · `flow.output` | Implemented |
| `port` · `call` · `needs` · `MockHost.invoke` | Implemented |
| Interpreted vs compiled execution (both through Host) | Implemented |
| 1000-pack stress and Unicode identifiers | Implemented |
| `import` across packs and port versions (`@ver`) | Implemented |
| Pack install / list / remove CLI | Implemented |
| Real Host CLI/HTTP execution adapter | Future P3 |

The package stress suite generates 1000 synthetic packs plus an adversarial
set and runs full `parse -> validate -> compile -> interpret` over them.
The adversarial suite is what keeps a synthetic "all green" run from hiding
weak cases; it caught Unicode identifiers and capability-only packs (ports
without flows) as regressions.

## DSL engine

The engine is the `packages/polaris-workflow` package. It has no web service
and owns no UI, tenants, Vaults, or scheduling. It exposes
`parse -> resolve -> validate -> compile/interpret` plus the Host/FFI
boundary:

```text
source
  -> parse
  -> resolve imports
  -> validate
  -> compile Program
       |
       +-> interpret (walk AST, same Host)
       +-> Program.run(flow, input)
             -> FfiHost.invoke(port, version, input)
             -> RPC request + capability lease
             -> receipt -> event -> artifact projection
```

| Stage | Module | Responsibility |
| --- | --- | --- |
| Parse | `src/dsl/parser.ts` | Comments, Unicode identifiers, v0.3 and v0.4 syntax |
| AST | `src/dsl/ast.ts` | Domain, module, entity, port, and flow types |
| Resolve | `src/dsl/resolve.ts` | Expand `import`, merge symbols, pin port versions |
| Validate | `src/dsl/validator.ts` | Closed uses/output, known ports, Host tool inventory |
| Compile | `src/dsl/compiler.ts` | Bake a `Program` that calls Host by port symbol |
| Interpret | `src/dsl/interpreter.ts` | Walk the AST through the same Host |
| Runtime | `src/dsl/runtime.ts` | Context, require guards, step I/O |
| Host | `src/dsl/host.ts` | Port table and `invoke` |
| RPC | `src/dsl/rpc.ts` | Versioned request, lease check, receipt |
| Pipeline | `src/dsl/pipeline.ts` | `runPipeline`, the supported entry |
| UI model | `src/dsl/ui-model.ts` | Flow and module projections for a renderer |

A compiled Program still carries port symbols. Inlining a CLI path would weld
deployment detail into the pack.

Every Host repeats `checkFfiAdmission`: pack digest present, lease present,
lease pack digest equals run pack digest, lease Vault equals request Vault,
and lease not expired. `FfiRpcRequest` carries protocol version, request and
idempotency IDs, tenant, Vault, run, pack digest, capability lease, port and
version, effect, optional built-in, input, mode, and trace. Every call
produces a receipt that Polaris persists with the request ID as the
idempotency boundary.

Polaris supplies the durable runtime in `apps/polaris`:
`WorkflowControlService` plus the SQLite control store (`workflow_runs`,
`workflow_outbox`, capability leases, events). Admission before execution
checks the lease, the Vault projection, and the exact verified pack bytes
selected by ID, version, and digest. Each worker claim has an expiry and can
be recovered after process loss. Every transition appends an event and outbox
item transactionally, artifacts are bounded projections, and suggestions
remain `suggested` and non-executable. Planned execution work is tracked in
the [Polaris PRD](/development/prd).

Verified installations live outside every Vault:

```text
$POLARIS_DATA_ROOT/control/domain-packs/<domain>/<version>/
    main.ord
    manifest.json
```

`manifest.json` records pack identity, version, install time, and the SHA-256
of `main.ord`. `pack list` recomputes the digest and reports `verified` or
`drifted`. A drifted installation is omitted from the Portal catalog and is
not used as an import.

## DSL examples

First-party packs live in `packs/`. The examples below are excerpts.

### First-party research pack

`packs/autoresearch/main.ord` declares the `AutoResearch` pack. Collection,
analysis, and report production are pack ports; `LiteratureReview` is a
14-step flow that ends in a PDF report:

```text
port codex version "1.0.0" {
  in { question: String }
  out { keywordPlanRef: String, keywordCount: Number, keywordStatus: String }
  effect ffi
  binding { tool "codex" }
}

flow LiteratureReview title "Literature Review" create {
  input {
    question: String required control textarea label "Research brief"
    decisionContext: String required label "Decision context"
    audience: String required label "Audience"
    reviewMode: String required label "Collection review mode"
    reportTemplate: String required label "Report template"
  }
  steps {
    planKeywords "Plan search keywords" {
      uses { question }
      call codex
      command "plan-search-keywords"
      output { keywordPlanRef: String, keywordCount: Number, keywordStatus: String }
    }
    capturePdfs "Capture PDFs" {
      uses { expandedCollectionRef }
      map item in expandedCollectionRef call pdf.capture
      command "capture"
      output { capturedCollectionRef: String, captureStatus: String }
    }
  }
  output {
    pdfRef: String from pdfRef
    markdownRef: String from markdownRef
  }
  ui { layout wizard primary "Review" icon "book-open" }
}
```

### Human review as a generic built-in

The pack owns the review fields and labels; Polaris owns the approval state
machine. The current mock Host returns a deterministic `waiting` receipt:

```text
flow ReviewBrief title "Review brief" create {
  needs { ReviewPlan }
  input { subject: String required }
  steps {
    review "Manual review" {
      uses { subject }
      call ReviewPlan
      output { approved: Boolean, reviewId: ID }
    }
  }
  output { approved: Boolean from approved, reviewId: ID from reviewId }
  ui { layout form primary "Submit" }
}
```

### Cross-pack composition

A sales pack imports an inventory capability pack. The kernel does not grow
an `inventory` keyword:

```text
domain Inventory version "1.2.0"
port ReserveStock version "2.0.0" {
  in { sku: String, qty: Number }
  out { reservationId: String }
  effect ffi
}

domain SalesFulfillment version "1.0.0"
import Inventory version "^1.2"

flow Place {
  needs { ReserveStock@2.0.0 }
  steps {
    reserve {
      uses { sku, qty }
      call ReserveStock@2.0.0
      output { reservationId: String }
    }
  }
}
```

## CLI

Workflow CLI commands and their flags:

```bash
pnpm --dir apps/polaris run polaris -- pack add <file.ord|pack-directory>
pnpm --dir apps/polaris run polaris -- pack list
pnpm --dir apps/polaris run polaris -- pack remove <domain> [--version <x.y.z>]

pnpm --dir apps/polaris run polaris -- ops workflow-smoke [--json]

pnpm --dir apps/polaris run polaris -- ops workflow-admit-live-metadata \
  --tenant <userId> --vault <vault> --pack <packId> --flow <flowId> \
  --operator <operatorId> --candidate-live-enabled \
  [--value key=value ...] [--release-id <id>] [--dedupe-key <key>] \
  [--wait] [--json]

pnpm --dir apps/polaris run polaris -- ops workflow-live-metadata-drill \
  --user <userId> --vault <vault> --candidate-live-enabled \
  [--release-id <id>] [--json]
```

The live commands require both deployment flags:

```text
POLARIS_WORKFLOW_LIVE_ADAPTER=enabled
POLARIS_WORKFLOW_LIVE_WORKER_BINDING=enabled
```

`ops workflow-admit-live-metadata` requires an operator identity, a release
id, explicit candidate acknowledgement, a current user-owned runnable Vault,
required flow inputs, an immutable installed pack digest, and exactly one
compiled read call. It records a `workflow.live.admit` audit event before the
queued run drains through the ordinary worker.

The workflow HTTP API is the non-CLI surface for the same objects:

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/api/workflow-vaults` | GET | User Vaults with server-derived run availability |
| `/api/workflow-setup` | GET/PUT | Read or persist pack, Vault, and enabled flows |
| `/api/workflow-runs` | GET/POST | List or submit durable runs |
| `/api/workflow-runs/:runId` | GET/DELETE | One run projection |
| `/api/workflow-runs/:runId/events?after=:cursor` | GET | Replayable ordered events |
| `/api/workflow-runs/:runId/{approve,cancel,retry}` | POST | Durable transitions |
| `/api/workflow-runs/:runId/artifacts/:artifactId` | GET | Bounded artifact projection |
| `/api/workflow-suggestions` | GET/POST | Non-executable deterministic drafts |

Language, RPC, pack, and runtime checks:

```bash
pnpm --filter polaris-workflow run typecheck
pnpm --filter polaris-workflow test
pnpm --filter polaris run test:domain-packs
pnpm --filter polaris exec tsx --test tests/polaris-workflow-control.test.ts
```

The package also generates and stresses synthetic packs with
`pnpm --filter polaris-workflow gen:packs`, `stress:packs`, `gen:adv`, and
`stress:adv`.

## Code and documentation map

### Core package

| Path | Role |
| --- | --- |
| `packages/polaris-workflow/src/dsl/` | Parser, AST, resolve, validate, compile, interpret, runtime, host, RPC, pipeline, UI model |
| `packages/polaris-workflow/src/index.ts` | Barrel export of the DSL modules |
| `packages/polaris-workflow/test/` | `core.test.ts` (parser/compiler/pipeline), `rpc.test.ts` (FFI RPC, admission) |
| `packages/polaris-workflow/scripts/` | Pack generators and stress runners (`generate-*.mts`, `stress-*.mts`) |
| `packages/polaris-workflow/generated/` | Generated packs and stress reports |

### Runtime and server code

| Path | Role |
| --- | --- |
| `apps/polaris/scripts/portal/workflow/workflow-control.ts` | `WorkflowControlService`: setup, admission, runs, approve/cancel/retry, receipts, artifacts, events, suggestions |
| `apps/polaris/scripts/portal/control-store.ts` | SQLite `workflow_runs`, `workflow_outbox`, leases, run records |
| `apps/polaris/scripts/portal/workflow/workflow-mock.ts` | Mock fixtures and Vault projection helpers |
| `apps/polaris/scripts/portal/workflow/workflow-live-boundary.ts` | Live-execution gates and action catalog |
| `apps/polaris/scripts/portal/workflow/workflow-live-tool-gateway.ts` | Shared live execution shape and durable evidence |
| `apps/polaris/scripts/portal/workflow/workflow-live-vault-adapter.ts` | Candidate `polaris.projection` tool definition |
| `apps/polaris/scripts/portal/workflow/workflow-live-worker-binding.ts` | Worker-thread binding for live reads |
| `apps/polaris/scripts/portal/workflow/workflow-tool-dispatcher.ts` | Tool process spawning for FFI invocations |
| `apps/polaris/scripts/portal/server.ts` | `/api/workflow-*` HTTP routes |
| `apps/polaris/scripts/config/domain-packs.ts` | Pack install/list/delete and graph projection |

### Shared types and front ends

| Path | Role |
| --- | --- |
| `packages/polaris-shell/src/workflow.ts` | Shared workflow projections and run/artifact/event types |
| `packages/polaris-tools/src/index.ts` | Tool manifest with `category: "workflow"` and workflow block |
| `apps/polaris-portal/src/workflow-mocks.ts`, `workflow-graph-layout.ts` | Portal UI mocks and graph layout |

### CLI and scripts

| Path | Role |
| --- | --- |
| `apps/polaris/scripts/cli/commands/workflow-smoke.ts` | Mock-only end-to-end smoke |
| `apps/polaris/scripts/cli/commands/workflow-admit-live-metadata.ts` | Live metadata admission |
| `apps/polaris/scripts/cli/commands/workflow-live-metadata-drill.ts` | Live drill |
| `scripts/tests/workspace-base-image-workflow.test.mjs` | Base-image workflow regression test |
| `scripts/release/capacity-gateway-load.mjs` | Load profile over workflow endpoints |
| `tools/*/runner.py` | Tool workflow adapters (codex, data-collection, intelligence-analysis, report-writing, manual-review, outreach) |
| `.github/workflows/build-workspace-base-image.yml` | CI workflow for the workspace base image |

### Tests

| Path | Role |
| --- | --- |
| `apps/polaris/tests/polaris-workflow-*.test.ts` | Control, smoke, mock, live boundary, gateway, adapter, worker binding, drill |
| `apps/polaris/tests/polaris-control-store.test.ts` | Atomic run admission and lease recovery |
| `packages/polaris-workflow/test/` | Language and RPC tests |
| `apps/polaris-portal/src/workflow-*.test.ts` | Portal UI tests |

### DSL data and schemas

| Path | Role |
| --- | --- |
| `packs/autoresearch/main.ord` | First-party Literature Review pack |
| `tools/tool-inventory.json` | Workflow command inventory |

### Documentation

| Path | Role |
| --- | --- |
| `apps/docs/site/polaris/workflow.md` | This page |
| `apps/docs/site/polaris/cli.md` | Full CLI command reference |
| `apps/docs/site/polaris/polaris-portal.md` | Portal workflow API and flow |
| `apps/docs/site/development/prd.md` | Product requirements ground truth |
| `CHANGELOG.md` | Workflow slices per release |

## Related

- [Polaris CLI](./cli.md)
- [Polaris Portal](./polaris-portal.md)
- [Polaris PRD](/development/prd)
