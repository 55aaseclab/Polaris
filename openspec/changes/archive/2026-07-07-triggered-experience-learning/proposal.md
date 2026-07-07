## Why

Polaris now has a working evolution kernel, but the current
triggered-experience-learning direction is the wrong abstraction.

It is too centered on:

- explicit learn triggers
- lesson summaries
- generated skill-like outputs

The user direction is different.

Polaris should adopt a durable memory system closer to Hermes, but implemented
at the Polaris and Paseo boundary rather than inside one harness.

That means Polaris should support:

- bounded persistent memory files
- separate workspace memory and user memory
- explicit memory write operations
- background review that proposes or writes memories
- optional approval before writes land
- frozen prompt snapshots for session stability
- optional external memory providers

The goal is not to learn `AGENTS.md`, and not to create skills.

The goal is to remember:

- project facts
- environment facts
- operator preferences
- durable learned facts

across sessions, in a generic way that different harnesses can consume.

## What Changes

- Replace the lesson and generated-skill model with a memory model centered on
  bounded `MEMORY.md` and `USER.md`.
- Introduce explicit memory operations equivalent to `add`, `replace`, and
  `remove` at the Polaris layer.
- Add a background review path that can propose or persist memory updates after
  meaningful runs.
- Add write-approval policy so memory writes can be automatic or staged for
  operator approval.
- Define frozen memory snapshot semantics so sessions load memory at session
  start rather than mutating prompt context continuously mid-run.
- Add optional memory-provider integration for retrieval, sync, and session-end
  extraction.

## Capabilities

### New Capabilities

- `workspace-memory`: Durable workspace and user memory with bounded local
  files, write policy, review, retrieval, and provider integration.

### Modified Capabilities

- `workspace-orchestration`: Agent sessions gain memory snapshot assembly and
  memory-aware run lifecycle hooks.
- `workspace-runtime-contract`: Runtime evolution state includes memory
  artifacts, pending memory writes, and optional provider sync state.

## Impact

- Affected code:
  - `apps/polaris/scripts/evolution/**`
  - `apps/polaris/scripts/backends/*/render.ts`
  - future Paseo runtime-observer and review helpers
- Affected systems:
  - workspace-local `MEMORY.md`
  - user-scoped `USER.md`
  - control-plane memory state under `config/users/<user-profile>/polaris/**`
  - runtime evolution state under `.paseo/evolution/`
  - optional external memory providers
- Affected behavior:
  - future sessions load durable memory snapshots at session start
  - runs may propose or persist memory updates after meaningful outcomes
  - operator approval may gate memory writes
  - external providers may enrich retrieval and post-run memory sync
