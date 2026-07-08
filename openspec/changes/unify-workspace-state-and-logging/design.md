## Context

Polaris currently splits workspace truth across four layers:

1. executor action handlers write partial status updates
2. backend observation synthesizes readiness from live evidence
3. `state/status.json` merges incoming fragments field-by-field
4. portal and admin views add local display logic on top

That layering has produced repeated bugs:

- action labels drift from actual runtime state
- one operation path updates status while another path does not
- portal polling re-derives state differently from the backend
- stale or partial writes survive longer than the live condition that caused
  them
- logs are too ad hoc to explain which phase was slow or which layer rewrote
  state

The affected code spans executor operations, runtime-controller synthesis,
state-store merge logic, portal summary/detail loaders, and React display
helpers. This is a cross-cutting change with behavior, migration, and
diagnostics impact, so it needs an explicit design.

## Goals / Non-Goals

**Goals:**

- Establish one canonical workspace lifecycle state contract.
- Make backend observation feed that contract instead of competing with it.
- Make portal and admin UI consume state without inventing parallel truth.
- Add structured logs for lifecycle transitions and slow paths.
- Make performance debugging possible with phase timing rather than scattered
  `console.log`.
- Preserve enough operational detail for diagnosis without reintroducing
  duplicated status fields.

**Non-Goals:**

- Rename workspaces to another product term.
- Redesign the full portal UX.
- Introduce a new external logging backend.
- Persist verbose diagnostic payloads as durable workspace state.
- Reintroduce polling-heavy daemon status checks as a general readiness source.

## Decisions

### Decision: Define a canonical workspace state envelope

Polaris will treat workspace state as one control-plane envelope with three
parts:

- durable lifecycle state
- live observation summary
- optional transient operation marker

The durable lifecycle state is the only long-lived state written to
`status.json`. Live observation summary is derived from backend evidence and
stored only when it represents the current resolved truth. Transient operation
markers represent in-flight actions such as start, stop, archive, delete, and
rebuild, and they must be cleared or resolved by the same action pipeline that
set them.

Why this over the current merge-anything model:

- the current field-wise merge keeps stale fragments alive
- multiple writers can preserve mutually inconsistent fields
- UI code compensates by inventing local precedence rules

Alternative considered:

- Keep the current schema and only tighten frontend precedence rules.
  Rejected because it leaves the backend ambiguity intact and keeps regressions
  likely.

### Decision: Centralize state resolution in one backend-side resolver

Executor actions, background refreshes, and portal reads will all depend on
one resolver that takes:

- workspace spec
- live backend observation
- runtime drift or blocking evidence
- optional in-flight operation context

and returns the canonical state envelope.

`runtime-controller` already synthesizes part of this, but executor operations
also mutate status directly and `state-store` merges partial payloads. The new
design moves lifecycle semantics to one resolver and reduces `state-store` to
validated replace-or-resolve writes instead of arbitrary field merging.

Alternative considered:

- Let each action handler keep its own status mutation logic but add tests.
  Rejected because each new action would keep re-encoding the same semantics.

### Decision: Separate live evidence from display-only interpretation

Portal and admin views must consume the resolved workspace state and only add
pure presentation logic such as translations, icons, and button enablement.
They must not reinterpret backend liveness, stitch stale cached fields
together, or infer hidden lifecycle states from unrelated fields.

This means:

- sidebar, main pane, and admin pane use the same state contract
- iframe readiness follows the same resolved signal that detail views use
- no UI path writes or rewrites canonical status because of local rendering
  needs

Alternative considered:

- Keep lightweight UI-local state adapters for different panes.
  Rejected because this is how state drift reappears under a different name.

### Decision: Introduce structured lifecycle and timing logs

Polaris will add a thin internal logging layer for workspace operations. Each
log record will be structured and scoped by:

- user id
- workspace name
- driver target
- action or phase
- outcome
- elapsed milliseconds
- selected evidence keys

The logging layer is for process logs, not persisted workspace data. It should
support at least:

- lifecycle transition logs
- refresh request logs
- iframe target publication logs
- slow-path warnings for expensive phases
- executor disconnect or retry logs with concrete cause

Why this over more raw `console.log`:

- ad hoc strings are hard to correlate
- phase timing needs consistent keys to compare runs
- we need to measure latency without mutating workspace status

Alternative considered:

- Build a new shared logging package first.
  Rejected for this change because the immediate need is semantic consistency;
  a thin Polaris-local layer is enough and can be extracted later.

### Decision: Reduce persisted state to unique truth

Fields that duplicate live daemon diagnostics or display derivations will be
removed from durable workspace state. Persisted status should answer:

- what lifecycle state the control plane believes the workspace is in
- what the last resolved readiness result was
- why it is blocked or degraded when not ready
- what operation is currently in flight, if any

Detailed daemon diagnostics, raw pair payloads, and verbose timing traces stay
out of `status.json` and remain available through on-demand commands or logs.

Alternative considered:

- Persist both summary and raw diagnostics for convenience.
  Rejected because it recreates split truth and stale-data failure modes.

## Risks / Trade-offs

- [Resolver rewrite touches many paths] → keep the canonical resolver narrow,
  add regression tests per action, and migrate callers one by one behind the
  same contract.
- [Status schema shrink may break UI assumptions] → update portal types and
  views in the same change, and cover summary/detail/admin scenarios in tests.
- [Less persisted detail may reduce debuggability] → compensate with
  structured logs and explicit on-demand diagnostic commands.
- [Transient operation markers can still get stuck on crashes] → require every
  action completion path and refresh reconciliation path to clear or overwrite
  stale in-flight markers deterministically.
- [Performance instrumentation can become noisy] → define a small fixed set of
  event names and emit slow-path warnings only above a threshold.

## Migration Plan

1. Define the new canonical workspace state schema and resolver.
2. Update backend synthesis and executor lifecycle handlers to write only that
   schema.
3. Replace merge-heavy status writes with validated replace-or-resolve writes.
4. Update portal loaders and UI action helpers to consume the canonical state.
5. Add structured logs and phase timing around refresh, start, stop, archive,
   rebuild, and iframe target resolution.
6. Backfill tests that lock action transitions, refresh reconciliation, and
   cross-workspace isolation.
7. Roll out with temporary compatibility reads only if needed during the same
   deploy; remove them before archive if the repo no longer needs them.

Rollback is straightforward because the change stays inside Polaris and its
portal. If needed, the previous resolver and schema handling can be restored by
reverting the change set.

## Open Questions

- Which exact lifecycle vocabulary should remain public after removing
  duplicated fields?
- Should slow-path logging thresholds be global or per action?
- Does the repo want a future shared logging package after this Polaris-local
  cleanup, or is a local layer sufficient long term?
