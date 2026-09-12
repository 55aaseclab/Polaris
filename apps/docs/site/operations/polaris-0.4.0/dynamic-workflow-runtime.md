# Polaris 0.4.0 Dynamic Workflow Runtime

Status: the deterministic runtime boundary is implemented for the Phase 3-6
mock-only slice. Durable queue state, worker leases, approval waits, event
replay, FFI receipts, artifacts, and non-executable suggestions are live in
the Polaris control store. A real Vault adapter, external event waits, and
AI-generated plan patches remain future boundaries.

## Meaning Of Dynamic

Dynamic means that a durable run can continue from persisted state after a
human decision, retry, or process restart. It does not mean that a model may
emit arbitrary code, select a new Vault, or silently rewrite a published
workflow.

The current state machine is intentionally small:

```text
immutable pack digest + flow
             |
             v
queued -> running -> succeeded
                 \\-> waiting --human approve--> running
                 \\-> failed  --retry---------> same queued run
queued/running/waiting --cancel----------------> cancelled
```

The DSL currently remains a flow and data-processing surface. Conditional
routing, feedback, retries, and durable checkpoints remain future runtime
work; they do not create a separate trial language.

The run retains its original pack version and digest across every transition.
Retry requeues the same run id with source `retry` and keeps completed
step results. It does not create a new run.

## Runtime Topology

For the 0.3.4 single-host boundary, the runtime is an internal loop beside
the existing Portal process and control store:

```text
Portal command / provisioning completion
                 |
                 v
        workflow_envelopes
                 |
                 v
       workflow_runs queue
                 |
        claim + worker lease
                 |
                 v
      pack compiler + mock Host
          |       |       |
          |       |       `-> synthetic artifact
          |       `----------> effect receipt
          `-------------------> WorkflowEvent + outbox
                                      |
                                      v
                              Portal card / Debug
```

There is no public workflow port, second scheduler, Kafka topic, Redis queue,
or direct private surface route. The interval is only a wake-up mechanism. SQLite
`available_at`, worker owner, and expiry remain authoritative.

## Runtime Invariants

1. A run is tenant- and Vault-scoped.
2. Exact verified pack bytes are selected by ID, version, and digest.
3. A current capability lease must match both pack digest and Vault ID.
4. Every worker claim has an expiry and can be recovered after process loss.
5. A waiting run releases its worker owner before human approval.
6. Every transition appends an event and outbox item transactionally.
7. Effect receipts are idempotent by request ID.
8. A cancelled run is terminal until retry requeues the same run.
9. Artifacts are bounded projections with digest and redaction metadata.
10. Suggestions are durable but `suggested` and non-executable.
11. No mock call has an external side effect.

## Admission Before Execution

The worker never executes a run merely because it is queued:

```text
read run
  -> load capability lease for tenant
  -> expire an overdue lease
  -> compare lease pack digest with run pack digest
  -> compare lease Vault with run Vault
  -> re-read current Vault projection and canRun decision
  -> load exact verified pack bytes
  -> execute deterministic Program with mock Host
```

Any failure records a bounded error and a failed event. There is no fallback
to a retained driver, another pack version, a public port, or a browser
decision.

The RPC validator repeats the same invariant for each call:

```text
pack.digest is present
lease.id is present
lease.packDigest == pack.digest
lease.vaultId == request.vaultId
lease.expiresAt > now
```

This is the gate for a future live or AI Host as well. Ordinary
Vault-target and provisioning policy still sends `mode: mock`. Host runs
persist `mode: host`. Live mode exists only on the operator
metadata-admission path.

## Deterministic Worker And Concurrency

The worker selects the oldest due row whose status is `queued`, or a `running`
row whose owner is empty after a recovery transition. A transaction assigns a
unique worker owner and expiry. Another worker cannot claim the same row while
the lease is active.

When a worker loses its lease, the next claim resets the stale running row to
queued and owns it. A future long call must heartbeat and reconcile its
receipt; it must not assume exactly-once execution from a timer.

Provisioning runs use a unique dedupe key:

```text
tenant + pack id + pack version + pack digest + flow id + Vault id
```

Manual runs and retries receive unique envelope keys. Effect requests receive
an idempotency key derived from run and request ID. Duplicate receipt inserts
are ignored, while the original receipt remains the evidence record.

## Approval And Built-ins

The built-in `manual.review@1.0.0` is a generic interface in the workflow
package. A Domain Pack declares a port binding and calls it from a flow. The
Host returns a deterministic `waiting` receipt. Polaris then:

1. persists output and an `approval-required` event;
2. releases the worker owner;
3. projects the run as a user attention card;
4. accepts approval only from the current tenant's run projection;
5. records an `approved` event and approval marker; and
6. lets the next worker claim and complete the run.

The Domain Pack supplies fields and labels. It does not implement the
approval state machine.

## Events, Outbox, And Replay

`workflow_events` has a per-run sequence for rendering a timeline and a
tenant-global autoincrement cursor for reconnect/replay. The outbox row is
created in the same transaction as the event. The current Portal reads the
durable projection by polling; the outbox is ready for a later delivery worker
without changing the card contract.

Replay uses the global cursor, not the per-run sequence:

```text
GET /api/workflow-runs/:runId/events?after=<tenant-global-cursor>
```

The response returns events for that run and the newest tenant cursor. This
keeps reconnect behavior correct when another run appended an event between
two reads.

## FFI And Receipts

The compiled [Polaris DSL](../../polaris/dsl.md) Program retains versioned
port symbols. The mock Host turns a
call into an RPC request containing protocol, request/idempotency IDs, tenant,
Vault, run, pack digest, capability lease, port/version, effect, optional
built-in, input, mode, and trace. The response contains status, output, error,
and receipt. Polaris persists the receipt before completing or waiting the
run.

The current host only returns synthetic values and cannot call a shell,
network, model, private surface route, or Vault package.

## Artifacts And Debugging

The mock host creates a bounded Markdown projection after success. Its content
includes run identity, pack pin, Vault name, and serialized mock output. The
control store persists content, size, kind, digest, and redaction flag.

The Portal work card is the daily projection. The Debug tab is an operator
projection of the same run rows, event timeline, policy decision, lease,
receipt, and artifact metadata. It is not a second log source and cannot edit
run state.

## Phase 6 Suggestion Boundary

The current suggestion endpoint accepts a successful run and records a
deterministic draft descriptor:

```text
status: suggested
sourceRunId: completed run
pack: id + version + digest
flowId: source flow
calls: receipt port/version references
evidence: source run and event IDs
```

The record is not a `WorkflowDefinition`. It cannot be enabled, scheduled, or
executed. AI generation is later work. A future proposer may write a
[Polaris DSL](../../polaris/dsl.md) fragment or AST, but Polaris must
validate it, dry-run it without effects, require human publication, and issue
a new immutable version before any run can reference it.

## Security And Recovery

- Session and tenant checks happen before every Portal workflow route.
- The service loads only user-owned Vault projections and returns not-found for
  cross-tenant run IDs.
- Pack drift and digest mismatch fail closed.
- Lease expiry, revocation, and Vault unavailability stop the next execution.
- Worker recovery does not duplicate a logical provisioning run because
  admission and dedupe are transactional.
- Event and outbox writes share the transition transaction.
- Effect records are bounded and artifact projections retain digest/redaction
  information.
- Mock-only mode has no external side effect and is not live AI evidence.

## Future Live Boundary

The following are explicitly not part of this implementation:

1. a real Vault Host or package loader;
2. private surface mutation calls from a workflow;
3. external connector effects, email, outreach, deployment, or deletion;
4. durable external-event waits and timer-driven plan revisions;
5. arbitrary Agent code or model-selected tools; and
6. AI-assisted workflow generation.

The source tree now includes a disabled live-boundary evaluator and action
catalog in `apps/polaris/scripts/portal/workflow-live-boundary.ts`. The
catalog is derived from the official `packages/polaris-tools` manifests. The
default catalog remains disabled for live execution. It repeats FFI admission
and fails closed unless
the deployment flag, receipt reconciliation, budget, kill switch, audit,
rollback, deployment evidence, and action enablement are all present.

A generic live tool gateway now lives beside it in
`apps/polaris/scripts/portal/workflow-live-tool-gateway.ts`. It owns the
shared live execution shape: repeat admission, match the catalog action to an
executor family, pass abort signals, normalize output, and record durable
receipt/audit evidence only for admitted executions or admitted execution
failures. This keeps Polaris from growing one adapter per tool.

The disabled read-only Vault metadata pilot now registers as the first
`polaris.projection` tool definition in
`apps/polaris/scripts/portal/workflow-live-vault-adapter.ts`. It reuses the
gateway, never calls the metadata reader before admission, and only projects
bounded summary fields. Its default reader uses Polaris-owned cached Vault
status/evolution metadata for the request tenant and Vault, requires the
selected driver to be running, and does not read artifact content. It is still
the only candidate live tool route in the ordinary worker.

The gateway also has a durable evidence wrapper for admitted reads. It writes
an idempotent effect receipt and immutable audit event only after the live
boundary admits the selected action, reconciles duplicate request IDs to the
original evidence, and records admitted executor failures as failed evidence.
It does not write receipts or audit events for pre-admission denials, and it is
now used by the ordinary workflow worker for the candidate metadata route.

Worker integration is represented by both a review-stage precondition
evaluator and candidate-stage worker wiring. Review-stage checks require the
default action catalog to remain disabled and the worker to remain unwired.
Candidate-stage checks require a local reviewed candidate action, source
review, the `0.3.0-single-host` release profile, one live read counted against
the single job worker, a per-attempt and total timeout below the read SLO and
job lease, at most two idempotent retries for admitted read failures, a
fail-closed kill-switch checked before each attempt, durable receipt and audit
behavior, rollback that disables the binding while preserving evidence, and
focused deployment checks including `polaris-workflow-control`.

The ordinary worker now runs compiled programs through the async host path.
It routes only a durable run whose persisted policy is `mode: "live"` and
whose concrete call is `ArtifactMetadata@1.0.0` with read effect. The route
then requires both deployment flags:

```text
POLARIS_WORKFLOW_LIVE_ADAPTER=enabled
POLARIS_WORKFLOW_LIVE_WORKER_BINDING=enabled
```

If either flag is unset, the worker fails closed before the reader is called
and writes no metadata receipt or audit event. Public Vault-target and
provisioning UI admission still creates `mode: "mock"` runs. Host UI
admission creates `mode: "host"` runs. Ordinary UI-created workflow runs
are not live until a separate operator path admits a live-policy run.

That operator path now exists for the metadata pilot only:

```text
POLARIS_WORKFLOW_LIVE_ADAPTER=enabled \
POLARIS_WORKFLOW_LIVE_WORKER_BINDING=enabled \
pnpm --dir apps/polaris run polaris -- ops workflow-admit-live-metadata \
  --tenant <userId> \
  --vault <vault> \
  --pack <packId> \
  --flow <flowId> \
  --operator <operatorId> \
  --candidate-live-enabled \
  --value artifactScope=latest \
  --release-id <POLARIS_RELEASE_ID> \
  --wait --json
```

Admission is Polaris-owned. It requires an operator identity, release id,
explicit candidate acknowledgement, both live flags, a current user-owned
runnable Vault, required flow inputs, an immutable installed pack digest, and
exactly one compiled `ArtifactMetadata@1.0.0` read call. It records a
`workflow.live.admit` audit event before the queued run drains through the
same async worker host. It does not expose live execution through the tool
portal, private surface, setup provisioning, or ordinary UI-created workflow runs.

Operators can drill this path with:

```text
POLARIS_WORKFLOW_LIVE_ADAPTER=enabled \
POLARIS_WORKFLOW_LIVE_WORKER_BINDING=enabled \
pnpm --dir apps/polaris run polaris -- ops workflow-live-metadata-drill \
  --user <userId> --vault <vault> --candidate-live-enabled --json
```

The command requires a Polaris user-owned Vault with a running selected
driver. It creates a synthetic Polaris run, invokes the candidate helper, reads
bounded cached Vault status/evolution metadata, records one receipt and audit
event, and then marks the drill run succeeded or failed. It uses the same
candidate helper as the ordinary worker route.

Any additional live executor family must remain behind the same Polaris RPC,
lease gate, and live tool gateway. It must reuse timeout and retry semantics,
effect reconciliation, budgets, kill-switch handling, audit records, rollback
evidence, and deployment evidence. It cannot be introduced by changing the
Portal or adding a direct Vault/private surface URL.

## Verification

```text
pnpm --filter polaris-workflow test
pnpm --filter polaris exec tsx --test tests/polaris-control-store.test.ts
pnpm --filter polaris exec tsx --test tests/polaris-workflow-control.test.ts
pnpm --filter polaris exec tsx --test tests/polaris-workflow-live-tool-gateway.test.ts
pnpm --filter polaris exec tsx --test tests/polaris-workflow-live-boundary.test.ts
pnpm --filter polaris exec tsx --test tests/polaris-workflow-live-vault-adapter.test.ts
pnpm --filter polaris exec tsx --test tests/polaris-workflow-live-worker-binding.test.ts
pnpm --filter polaris exec tsx --test tests/polaris-workflow-live-metadata-drill.test.ts
pnpm --filter polaris exec tsx --test tests/polaris-portal.test.ts
pnpm --filter polaris-portal test
```

These checks prove persistence, admission, replay, worker recovery, approval,
cancellation, retry, receipts, artifacts, tenant isolation, and the disabled
suggestion contract. They also prove that a synthetic durable live-policy
metadata run can execute the candidate worker route only when both flags are
enabled, and fails closed with no reader call when they are not. They do not
certify arbitrary live tools or production AI execution. The smoke command is
the operator-facing proof that the default workflow path runs end to end
without live tools.
