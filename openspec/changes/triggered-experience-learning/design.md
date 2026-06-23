## Context

Polaris already has a universal evolution kernel and a runtime observer that
can capture daemon-observed agent outcomes and write runtime artifacts.
However, the current triggered-experience-learning direction is too narrow and
too awkward:

- it emphasizes trigger markers over durable memory policy
- it stores lesson-like summaries rather than stable memory
- it drifts toward generated skill artifacts

Hermes is the more useful reference model here.

In Hermes, memory is not a skill and not an `AGENTS.md`.
It is a durable cross-session store, mainly:

- `MEMORY.md`
- `USER.md`

plus optional memory providers.

That is where Hermes remembers:

- project conventions
- environment facts
- user preferences
- learned facts

The right Polaris translation is:

- keep memory harness-neutral
- keep memory bounded and inspectable
- separate workspace memory from user memory
- allow explicit memory writes
- allow background review
- support approval gates
- use frozen memory snapshots for session stability
- optionally integrate external providers later

## Goals / Non-Goals

**Goals:**

- Define a Polaris memory model centered on durable facts rather than lessons
  or skills.
- Separate workspace memory from user memory.
- Support explicit memory writes with `add`, `replace`, and `remove`
  semantics.
- Support background review that can propose or persist memory updates after
  meaningful runs.
- Support optional write approval before memory changes land.
- Define session-start memory snapshot semantics.
- Support optional external memory providers for retrieval and sync.
- Preserve manager and harness neutrality through Paseo-facing runtime hooks.

**Non-Goals:**

- Autonomous skill creation.
- Learning or rewriting `AGENTS.md`.
- Mid-turn prompt mutation on every memory write.
- Unbounded transcript retention as the primary memory format.
- Tying memory to Codex-only or Claude-only private state layouts.

## Decisions

### Decision: Polaris memory is split into workspace memory and user memory

Polaris memory will have two primary durable local files:

- workspace-scoped `MEMORY.md`
- user-scoped `USER.md`

They serve different purposes.

`MEMORY.md` stores:

- project facts
- environment quirks
- repository conventions
- durable workspace lessons

`USER.md` stores:

- operator preferences
- style preferences
- communication expectations
- durable user habits

Rationale:

- This mirrors the Hermes separation cleanly.
- It prevents user preferences from contaminating workspace facts.
- It gives Polaris a generic cross-harness contract.

Alternatives considered:

- One combined memory file.
  Rejected because workspace facts and user preferences have different scope and
  lifecycle.
- Memory encoded as generated skills or context overlays.
  Rejected because those are different abstractions.

### Decision: Memory is bounded Markdown, not an unbounded event log

Polaris memory files will be compact bounded Markdown documents.
They are the durable operator-facing memory surface.

The event log and structured artifact store may remain internal supporting
state, but they are not the memory interface.

Rationale:

- Operators can inspect and edit them directly.
- They are easy to diff, approve, archive, and inject.
- They match the Hermes ergonomics.

Alternatives considered:

- Only structured database state with no file form.
  Rejected because it is harder to inspect and reuse across harnesses.
- Full transcript persistence as memory.
  Rejected because memory should be distilled, not raw.

### Decision: Polaris supports explicit memory operations

Polaris memory writes will use three semantic operations:

- `add`
- `replace`
- `remove`

These apply to memory entries, not to arbitrary raw text mutation.

Each memory write should include:

- target memory file
- operation
- candidate content
- reason
- source run or session id

Rationale:

- This is the minimum precise write model needed for review, approval, and
  audit.
- It mirrors Hermes well enough without coupling to one tool API.

Alternatives considered:

- Append-only lesson insertion.
  Rejected because memory needs replacement and cleanup.
- Freeform rewrite of the whole file each time.
  Rejected because it weakens auditability.

### Decision: Background review may propose or persist memory updates

After a meaningful run, Polaris may review the result and derive memory
operations.

Typical triggers include:

- repeated user correction
- meaningful failure with durable remediation
- meaningful success that reveals a reusable workspace fact
- explicit operator request to remember something

The review path may:

- write directly
- queue a pending proposal
- do nothing

depending on memory policy.

Rationale:

- This keeps memory capture practical.
- It matches Hermes’ background review idea.
- It avoids making every memory change depend on explicit user syntax.

Alternatives considered:

- User-triggered memory only.
  Rejected because repeated corrections and durable facts should be capturable
  automatically.
- Fully automatic write-on-every-run.
  Rejected because it creates noise.

### Decision: Memory writes may require approval

Polaris memory policy will support at least two modes:

- automatic writes
- staged writes requiring approval

When approval is enabled, Polaris will record pending memory updates and expose
operator actions to approve or reject them.

Rationale:

- This gives a safe rollout path.
- It preserves trust when automatic review is still immature.

Alternatives considered:

- Always automatic.
  Rejected because hallucinated or weak memories are a real risk.
- Always manual.
  Rejected because it blocks useful automation.

### Decision: Sessions use frozen memory snapshots

Memory will be assembled at session start into a prompt snapshot.

If memory changes during a session:

- the durable memory files update immediately when policy allows
- the current session does not continuously rewrite its prompt context
- the new memory becomes visible on the next session or next explicit rebuild

Rationale:

- This preserves prompt stability and cacheability.
- It matches Hermes’ memory semantics closely.
- It keeps the runtime contract simpler.

Alternatives considered:

- Mid-session prompt mutation on every write.
  Rejected because it is unstable and hard to reason about.

### Decision: External memory providers are optional and additive

Polaris should define an optional provider contract for richer memory retrieval.

If a provider is enabled, Polaris may:

- fetch relevant memories before a run
- sync turns or summaries after a run
- extract durable memories at session end
- mirror approved local memory writes to the provider

The local bounded memory files remain the primary operator-visible memory
surface.

Rationale:

- This mirrors Hermes’ provider model without making Polaris dependent on one
  provider from the start.
- It keeps the local memory story strong even without external systems.

Alternatives considered:

- Provider-only memory.
  Rejected because local inspectable memory should exist even offline.
- No provider contract at all.
  Rejected because richer retrieval is a likely future need.

### Decision: Memory remains manager-neutral and harness-neutral

Paseo manages different harnesses, so memory cannot live only inside one of
them.

Polaris owns the memory model.
Harness adapters only consume memory snapshots.

The generic flow is:

1. Polaris stores and reviews memory
2. Paseo surfaces run boundaries and runtime metadata
3. Polaris assembles memory snapshots
4. Harness adapters consume those snapshots through their supported context
   mechanism

Rationale:

- This respects the existing architecture.
- It avoids rebuilding Hermes as a single harness.

## Memory Model

### Local memory files

Workspace memory:

- control-plane mirror:
  `config/users/<user-profile>/polaris/workspaces/<project>/MEMORY.md`
- runtime path:
  `<workspaceData>/.polaris/MEMORY.md`
- scope: workspace
- contents:
  - repo facts
  - environment quirks
  - validation recipes
  - recurring failure facts

User memory:

- control-plane path:
  `config/users/<user-profile>/polaris/USER.md`
- runtime path:
  `<userIdentityState>/polaris/USER.md`
- scope: user profile
- contents:
  - output preferences
  - review preferences
  - style expectations
  - durable operator constraints

The concrete rule is:

- workspace memory lives with the workspace
- user memory lives with the Polaris-managed user profile
- runtime adapters consume mounted runtime paths
- control-plane review and policy operate on the control-plane copies

### Session snapshot files

Polaris will assemble a frozen session snapshot for each session.

Control-plane snapshot path:

- `config/users/<user-profile>/polaris/workspaces/<project>/sessions/<session-id>/memory-snapshot.md`

Runtime snapshot path:

- `<evolutionRoot>/sessions/<session-id>/memory-snapshot.md`

The runtime snapshot is derived from:

1. workspace `MEMORY.md`
2. user `USER.md`
3. optional provider-retrieved entries
4. snapshot metadata

The snapshot is immutable for the lifetime of the session unless an explicit
rebuild action is invoked.

### Supporting state

Polaris may also keep structured state for:

- normalized execution events
- candidate memory operations
- pending approvals
- provider sync metadata
- curation history

That structured state supports the memory system, but is not itself the primary
operator-facing memory interface.

### Pending approval state shape

Pending memory updates will be stored as structured records under:

- `config/users/<user-profile>/polaris/workspaces/<project>/pending-memory.json`

The file contains an array of records with this logical shape:

```json
{
  "id": "memchg_123",
  "workspaceId": "demo",
  "userProfileId": "user-1",
  "target": "workspace-memory",
  "operation": "replace",
  "section": "Validation",
  "key": "run-verifier-first",
  "candidate": {
    "title": "Run verifier before retrying",
    "body": "Use the verifier before repeating the same failing command."
  },
  "reason": "Repeated correction observed across two sessions.",
  "sourceSessionId": "session-123",
  "sourceRunIds": ["run-1", "run-2"],
  "proposedAt": "2026-06-23T12:00:00.000Z",
  "status": "pending"
}
```

Required semantics:

- `target` is `workspace-memory` or `user-memory`
- `operation` is `add`, `replace`, or `remove`
- `section` identifies the markdown section to update
- `key` is the stable logical entry identifier
- `candidate` is omitted only for `remove`
- `status` is `pending`, `approved`, `rejected`, or `applied`

The approval log may stay in structured store tables later, but this is the
minimum concrete contract for first implementation.

### Memory entry shape

The bounded Markdown files are operator-facing, but Polaris will treat each
entry logically as:

- `key`
- `title`
- `body`
- `updatedAt`
- `source`

The markdown format should support stable machine updates by grouping entries
under top-level sections such as:

- `## Project Facts`
- `## Environment`
- `## Validation`
- `## Preferences`

Each entry should be rendered in a stable bullet form:

```md
- `run-verifier-first` Run verifier before retrying.
  Source: session-123. Updated: 2026-06-23.
```

This is intentionally simpler than freeform prose so `replace` and `remove`
remain deterministic.

## Update Flow

### Explicit write path

An operator or tool issues a memory operation:

- target: `MEMORY.md` or `USER.md`
- operation: `add`, `replace`, `remove`
- reason
- source

Polaris applies the change directly or stages it for approval.

### Background review path

After a meaningful run:

1. runtime observation captures candidate evidence
2. reviewer derives memory operations
3. policy decides:
   - reject
   - stage pending
   - apply immediately
4. local memory files update
5. optional provider sync runs

## Read / Use Flow

At session start:

1. Polaris loads bounded local memory files
2. optional provider retrieval enriches the candidate memory set
3. Polaris assembles a memory snapshot for the session
4. the selected harness receives that snapshot through its supported context
   assembly path

During the session:

- memory writes may land durably
- the session prompt snapshot stays frozen unless an explicit rebuild path is
  invoked
- background review may queue pending changes without affecting the snapshot

After the session:

- review may derive new memory updates
- provider sync may persist approved memory externally

## Session Snapshot Format

The assembled session snapshot is markdown with four sections in fixed order:

1. header
2. workspace memory
3. user memory
4. provider-retrieved memory

The header includes:

- project
- user profile
- session id
- snapshot timestamp
- provider status

Example:

```md
# Polaris Memory Snapshot

- Project: demo
- User profile: user-1
- Session: session-123
- Snapshotted at: 2026-06-23T12:00:00.000Z
- Provider: disabled

## Workspace Memory

...

## User Memory

...

## Provider Memory

_No external memory provider configured._
```

Harness adapters may project this snapshot into their own context assembly, but
this markdown shape is the manager-neutral source format.

## Risks / Trade-offs

- [Memory files could become noisy] → keep them bounded and curated
- [Background review could hallucinate facts] → support approval mode and
  source attribution
- [User memory and workspace memory could blur together] → separate scopes and
  policy clearly
- [Different harnesses may consume memory differently] → keep Polaris as the
  source of truth and adapters as projections
- [Provider sync may drift from local files] → keep local files authoritative
  unless policy explicitly changes that

## Migration Plan

1. Replace lesson-oriented semantics with memory semantics in the evolution
   layer.
2. Introduce local `MEMORY.md` and `USER.md` as the operator-facing durable
   memory surface.
3. Add explicit memory operations and pending-approval state.
4. Update runtime review so it derives memory operations rather than lessons or
   skills.
5. Add session-start memory snapshot assembly.
6. Add optional provider integration after the local memory flow is stable.

Rollback:

- disable background review writes
- keep explicit writes only
- disable provider sync
- preserve existing local memory files as the durable fallback

## Open Questions

- Should memory approval be on by default for early rollout?
- Should session snapshot rebuild be exposed explicitly to operators?
- Which provider contract should Polaris support first, if any?
