# Evolution Maturity

This document describes the current Polaris evolution loop as a memory system.

## Purpose

Polaris owns a manager-agnostic memory layer rather than treating memory as a
private feature of one specific harness.

## Scope And Files

Polaris keeps evidence, candidates, committed memory, provider data, and
session snapshots separate.

| Concern | Contents | Control-plane source of truth | Runtime / user-facing file |
|---|---|---|---|
| Runtime evidence | Execution events used to feed review | `config/users/<user>/polaris/workspaces/<project>/store.db` table `execution_events` | `<evolutionRoot>/execution-events.jsonl` and `<evolutionRoot>/memory-candidates.jsonl` |
| Pending memory changes | Candidate `add` / `replace` / `remove` records waiting for policy or approval | `config/users/<user>/polaris/workspaces/<project>/store.db` table `pending_memory_changes` | `config/users/<user>/polaris/workspaces/<project>/pending-memory.json` |
| Workspace memory | Committed workspace facts, environment quirks, validation recipes, and recurring recovery patterns | `config/users/<user>/polaris/workspaces/<project>/store.db` table `memory_entries` filtered to workspace scope | `config/users/<user>/polaris/workspaces/<project>/MEMORY.md` and `<workspaceData>/.polaris/MEMORY.md` |
| User memory | Committed user preferences and durable operator habits | `config/users/<user>/polaris/workspaces/<project>/store.db` table `memory_entries` filtered to user scope | `config/users/<user>/polaris/USER.md` and `<userIdentityState>/polaris/USER.md` |
| Optional provider mirror | External or provider-backed memory used for retrieval and sync | `config/users/<user>/polaris/provider-memory.json` | none |
| Session memory snapshot | Frozen per-session assembly of workspace memory, user memory, and optional provider memory | `config/users/<user>/polaris/workspaces/<project>/sessions/<session-id>/memory-snapshot.md` | `<evolutionRoot>/sessions/<session-id>/memory-snapshot.md` |

Current gaps versus Hermes:

- session search
- provider integration
- deeper provider-side user modeling and derived conclusions
- LLM review agent for deciding whether candidate memory is worth keeping
- bounded committed memory

## Polaris vs Hermes

| Algorithm | Polaris Today | Hermes Harness |
|---|---|---|
| Session-start memory assembly | 1. Open Polaris store. 2. Load workspace memory. 3. Load user memory. 4. Load optional provider memory. 5. Render frozen snapshot. 6. Hand snapshot to runtime. | 1. Load local memory surfaces. 2. Load optional provider-backed memory. 3. Assemble prompt-time memory snapshot inside Hermes. 4. Start session with that frozen memory context. |
| Retrieval scoring | 1. Filter entries to the current workspace, active status, and matching user scope. 2. Start each score from `confidence * 100`. 3. Add `+8` for `workspace-memory`. 4. Add `+6` for same user profile. 5. If prompt text exists, add `+20` for direct text match and `+12 + matchedTagCount` for tag matches. 6. Add a recency bonus of up to `+10`. 7. Sort by total score and take the top `limit` entries. | 1. Gather local memory and optional provider-backed memory. 2. Retrieve the entries most relevant to the current session. 3. Pass the selected memory into Hermes prompt assembly. |
| Post-run review | 1. Collect normalized execution events. 2. Run rule-based reviewer. 3. Derive candidate memory changes. 4. Drop low-confidence changes. | 1. Observe meaningful run outcome. 2. Run background review. 3. Derive durable memory candidates from repeated corrections, failures, or successful patterns. 4. Decide whether to write or propose memory. |
| Approval flow | 1. Save pending change record. 2. Keep status as `pending`. 3. Approve or reject later. 4. On approval, apply to durable memory surfaces. | 1. Queue pending memory write when approval is enabled. 2. Approve or reject through Hermes memory approval flow. 3. Persist only approved writes. |
| Memory write | 1. Represent change as `add`, `replace`, or `remove`. 2. Attach reason and source session. 3. Either stage or auto-apply by policy. 4. Persist resulting memory entry. | 1. Use Hermes memory operations/tooling. 2. Add, replace, or remove memory. 3. Persist directly or route through approval policy depending on config. |
| Provider sync | 1. Read optional provider file before run. 2. Include retrieved provider memory in snapshot. 3. After approved local writes, mirror entries back to provider file. | 1. Retrieve from configured external provider before or during session assembly. 2. Sync or extract durable memories after the session. 3. Keep provider and local memory in sync through Hermes provider integration. |

## Retrieval Explainability

Retrieved memory entries can record:

- retrieval score
- retrieval reasons
- retrieval timestamp
- prompt text used for matching

Typical retrieval reasons include:

- workspace-memory
- same user profile
- direct prompt text match
- matched tags
- recently updated

## Approval Policy

Polaris supports two write modes:

- `stage`
  - reviewed memory changes are written to pending approval state
- `auto`
  - approved-by-policy changes are applied immediately

The current default is `stage` unless `POLARIS_MEMORY_WRITE_POLICY=auto` is
set.

## Provider Integration

Polaris now has a minimal optional provider contract backed by a local mirror
file:

- retrieval reads from `config/users/<user>/polaris/provider-memory.json`
- approved local memory entries may be mirrored back into that file

This is intentionally simple but exercises the full provider loop:

- pre-run retrieval
- post-run sync

## Memory Loop

Polaris currently uses two different kinds of sessions:

1. **lifecycle session**
   one control-plane command run such as:
   - `render`
   - `start`
   - `apply`
   - `stop`
   - `restart`
   - `rebuild`
   - `status`
   - `reconcile`

2. **runtime agent session**
   a longer-lived agent run or conversation observed while the workspace is up

The memory loop is triggered in two ways:

- when a lifecycle session records execution events and then finalizes
- when runtime observation notices new daemon-owned agent state while the
  workspace is still running

For the exact sequence of steps after those triggers, see the algorithms in
**Polaris vs Hermes** above.

## Current Boundaries

The current implementation deliberately does **not**:

- rewrite `AGENTS.md`
- create autonomous skills
- mutate Codex or Claude private memory formats directly
- train model weights
- depend on Paseo internals as the source of truth for durable memory
