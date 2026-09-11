# Polaris 0.4.0 WorkEnvelope And Workflow Plan

Status: the durable Phase 3-6 implementation is complete in the current
mock-only execution mode. This document describes the implemented contracts,
their data/control flow, and the boundary for a later live Vault adapter.

## Design Premise

An occurrence of work, a reusable Domain Pack, and an execution are different
objects:

```text
source or human command
    -> WorkEnvelope
    -> WorkflowSetup / enabled flow
    -> WorkflowRun admission
    -> Vault capability lease
    -> deterministic worker
    -> WorkflowEvent + effect receipt + artifact
    -> Portal card and Debug projection
```

The Domain Pack and all workflow definitions are outside a Vault. A run is
bound to a Vault only after Polaris validates ownership, readiness, policy,
the immutable pack digest, and the capability lease. The Portal makes these
choices visible and handles human intervention; it never makes the admission
decision locally.

## Ownership And Storage

| Concern | Owner | Current implementation |
| --- | --- | --- |
| Identity, tenant, role, and Vault ownership | Polaris | Existing Authing mapping and Portal session |
| Pack source and flow catalog | Polaris | CLI-managed verified source under the data root |
| Setup and enabled flows | Polaris | `workflow_setups` |
| Admission occurrence | Polaris | `workflow_envelopes` with unique dedupe key |
| Capability grant | Polaris | `workflow_capability_leases` |
| Run and worker lease | Polaris | `workflow_runs` |
| Event delivery | Polaris | `workflow_events` and `workflow_outbox` |
| FFI effect evidence | Polaris | `workflow_effect_receipts` |
| Result projection | Polaris | `workflow_artifacts` |
| Draft suggestion | Polaris | `workflow_suggestions`, status `suggested` only |
| First-party tool catalog | Polaris | `packages/polaris-tools` manifests |
| Business declaration | Domain Pack repository | `.ord` source; no runtime authority |
| Domain surface | private surface or another private surface | Adapter only; no run scheduler |
| Execution cell | Vault | The selected target; live adapter is not enabled in this slice |

The store is durable SQLite WAL for the single-host 0.3.4 boundary. It is not
a second control plane. A future multi-host scheduler requires a separately
reviewed transactional backend and capacity evidence.

## Setup And Provisioning

`WorkflowSetup` records the selected Domain Pack, default Vault, enabled flow
keys, and completion time. The first-use story is:

1. The Portal loads verified packs and user-owned Vault projections.
2. The user chooses one pack as the work scene.
3. The user chooses an existing or disposable Vault that Polaris marks
   executable.
4. The user enables one or more flows inside the selected pack.
5. `PUT /api/workflow-setup` validates and persists the setup.
6. Polaris creates one provisioning run for every enabled flow.

Provisioning completion calls the same enqueue path. A repeated notification,
Portal refresh, or process restart is safe because the provisioning dedupe key
contains tenant, pack version/digest, flow, and Vault. A newly enabled flow
gets a new run; an existing flow is not silently duplicated.

## Admission And WorkEnvelope

Run creation is one transaction:

```text
validate user -> validate pack/flow -> validate owned executable Vault
    -> load exact verified pack bytes by id/version/digest
    -> create WorkEnvelope with dedupe key
    -> create Vault capability lease
    -> create queued WorkflowRun
    -> append submitted WorkflowEvent
    -> append workflow.outbox item
```

The envelope payload carries pack ID, version, digest, flow ID, Vault ID, and
run source. The run stores the same immutable pin rather than a mutable
catalog reference. If the exact source is missing or drifted, admission
returns `pack-pin-unavailable`; it does not fall back to another version.

The policy decision is persisted on the run. Current decisions are always
`allow` with `mode: mock` and explicit reasons such as:

```text
pack-digest-pinned
vault-capability-lease
provisioning-enqueue
mock-host-only
```

The policy is evidence for the decision, not a browser hint. The worker
rechecks the lease and Vault projection immediately before execution.

## Run State And Control Flow

The implemented aggregate states are:

```text
queued -> running -> succeeded
                 \\-> waiting -> running -> succeeded
                 \\-> failed -> retry -> queued
queued/running/waiting -> cancelled
```

The worker claims the oldest due queued run, or a running run whose previous
worker owner has been released or whose lease expired. A claim sets
`worker_owner` and `worker_expires_at`. The run is heartbeat-capable and the
next worker recovers an expired claim.

When a run reaches `waiting`, Polaris clears the worker owner and expiry. A
human approval changes the run to `running` with an approval marker, and the
next deterministic worker pass resumes it. Cancellation clears ownership and
is terminal. Retry always creates a new run with source `retry`; the old run
and its evidence remain immutable.

The current worker is deterministic. It does not ask a model to choose a
flow, invent a port, change a plan, or select a Vault. AI-assisted workflow
generation and dynamic plan patching are deliberately outside this phase.

## FFI, Built-ins, And Mock Host

FFI is part of the workflow definition, not an out-of-band tool list. A pack
declares a versioned port and calls it from a step:

```text
port ReviewPlan version "1.0.0" {
  builtin manual.review
  in { title: String, instructions: String }
  out { approved: Boolean, reviewId: ID }
  effect human
}
```

`manual.review` is a built-in interface in `packages/polaris-workflow`. It
defines input/output schema, human effect, approval requirement, and risk. It
does not contain a domain-specific review implementation. A Domain Pack
instantiates it by binding a port and declaring the flow call.

Official tool publication metadata lives in `packages/polaris-tools`. That
package is the single source for first-party tool manifests, disabled live
gates, mock receipts, the Polaris live action catalog projection, and the
standalone Polaris tool portal projection. private surface does not maintain a
duplicate tool list.

The generic RPC request includes:

- protocol version, request ID, idempotency key, run ID, tenant ID, and Vault;
- pack ID, version, and immutable digest;
- capability lease ID, lease digest, lease Vault, and expiry;
- port name/version, effect, optional built-in ID, input, mode, and trace ID.

The protocol validator rejects an empty digest, missing lease, digest
mismatch, Vault mismatch, or expired lease. The current host only accepts
mock execution and emits deterministic output. Polaris stores one effect
receipt per request ID. The host emits no real network, process, filesystem,
private surface, or AI side effect.

## Event And Card Flow

Every state transition appends an immutable event and an outbox item in the
same transaction. The event has a per-run sequence and a tenant-global replay
cursor. The event API replays by the persisted global cursor, so a Portal
reconnect does not confuse per-run sequence numbers with tenant ordering.

The Portal uses the same run projection for the work card and Debug tab:

```text
submitted -> started -> approval-required -> approved -> succeeded
     |           |             |               |          |
     |           |             |               |          `-> artifact
     |           |             `-> cancel       `-> receipt
     |           `-> failed -> retry
     `-> cancel
```

The card is an attention projection. The durable event, receipt, artifact
digest, policy decision, pack pin, and lease remain in Polaris. A card can be
rendered again after a process restart without relying on browser memory.

## Artifact And Suggestion Flow

The mock host serializes a synthetic Markdown artifact with the run ID, pack
pin, Vault name, and output. Polaris stores its digest, size, kind, redaction
flag, and content. The Portal can open the artifact only through the run
projection returned for the current tenant.

A successful run may be submitted to the suggestion endpoint. Polaris creates
a `suggested` record containing:

- the source run, pack ID/version/digest, and flow ID;
- the deterministic draft descriptor and receipt references; and
- the source run and event IDs as evidence.

No suggestion is automatically enabled, published, retried, or scheduled.
The future AI generator must write the same durable draft boundary and still
requires human review and a fresh policy decision.

## Portal API Contract

The authenticated same-origin API currently exposes:

```text
GET  /api/domain-packs
GET  /api/workflow-vaults
GET  /api/workflow-setup
PUT  /api/workflow-setup
GET  /api/workflow-runs
POST /api/workflow-runs
GET  /api/workflow-runs/:runId
GET  /api/workflow-runs/:runId/events?after=<cursor>
POST /api/workflow-runs/:runId/approve
POST /api/workflow-runs/:runId/cancel
POST /api/workflow-runs/:runId/retry
GET  /api/workflow-suggestions
POST /api/workflow-suggestions
```

All routes require the mapped Portal session and use the current tenant ID.
The server owns validation and status codes. The Portal client only projects
responses into Zustand and refreshes after mutations.

## Security And Resilience

- No request can choose a Vault outside the current tenant's owned projection.
- No run can execute without an exact verified pack digest and a current
  lease bound to the same Vault.
- Lease revocation and Vault admission failure are fail-closed checks before
  the host call.
- Idempotent envelope keys prevent duplicate automatic provisioning. Receipt
  request IDs prevent duplicate effect records.
- SQLite transactions cover admission, initial event, outbox append, state
  transitions, and artifact metadata. WAL and full synchronous mode preserve
  the single-host durability contract.
- Expired worker leases are recoverable. Waiting runs release their owner.
- Errors are stored with bounded codes/messages. Artifacts include digest and
  redaction metadata. Cross-tenant reads return not-found behavior.
- The mock-only policy means external side effects are absent. A later live
  adapter must add effect reconciliation, budgets, kill switches, and
  rollback evidence before it can be enabled.

## Developer And Operator Workflow

Domain Pack development happens in the pack repository or a local pack source:
write `.ord`, run DSL validation, and install through the Polaris CLI. Domain
Pack code must not import Polaris control-store internals or hardcode a Portal
route. Polaris owns the parser, registry, policy, leases, queue, RPC host,
and API. `packages/polaris-tools` owns first-party publication metadata.
private surface remains a private surface adapter, and a Vault receives only a
capability-limited envelope when a live adapter exists.

Focused verification for this slice is:

```text
pnpm --filter polaris-workflow run typecheck
pnpm --filter polaris-workflow test
pnpm --filter polaris-tools run typecheck
pnpm --filter polaris-tools test
pnpm --filter polaris exec tsc --noEmit
pnpm --filter polaris exec tsx --test tests/polaris-control-store.test.ts
pnpm --filter polaris exec tsx --test tests/polaris-workflow-control.test.ts
pnpm --filter polaris exec tsx --test tests/polaris-workflow-smoke.test.ts
pnpm --filter polaris run smoke:workflow
pnpm --filter polaris exec tsx --test tests/polaris-workflow-live-boundary.test.ts
pnpm --filter polaris exec tsx --test tests/polaris-portal.test.ts
pnpm --filter polaris-portal test
git diff --check
```

The deployment remains the existing 0.3.4 blue/green path. Operators inspect
health/readiness, the control-store file, worker logs, and Gateway policy as
before. There is no public workflow worker port and no direct private surface URL.

## Current Boundary And Later Work

Implemented here:

- durable setup, envelope, lease, run, event, outbox, receipt, artifact, and
  suggestion records;
- deterministic queue and recovery;
- generic RPC and `manual.review` interface;
- first-party `polaris-tools` catalog owned by Polaris;
- standalone Polaris `/tools` registry with Common tools and Domain Pack
  flow-tool calls;
- automatic provisioning enqueue;
- repeatable mocked workflow smoke command;
- mock-only host and synthetic artifacts; and
- non-executable deterministic suggestions.

Not enabled here:

- live Vault tool adapters or package installation into Vaults;
- private surface mutation calls from a workflow;
- external email, outreach, deployment, deletion, or credential effects;
- autonomous AI execution; and
- AI-assisted workflow generation or dynamic plan rewriting.

Those are new authority boundaries, not compatibility fallbacks. They require
their own design, migration, tests, deployment evidence, and release record.
The current disabled live-boundary evaluator is only the review scaffold for
that later work; it does not execute actions.
