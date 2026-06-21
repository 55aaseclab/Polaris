# Evolution Kernel

This document describes the current Polaris evolution loop: where learning
state lives, how it is produced, how it is consumed, and what is intentionally
kept out of scope.

## Purpose

Polaris now owns a manager-agnostic evolution layer rather than treating
learning as a private feature of one specific runtime manager.

Today, the first concrete manager is Paseo, but the evolution model is owned by
Polaris:

- managers execute work and expose runtime surfaces
- Polaris captures control-plane execution signals
- Polaris stores structured learning artifacts
- Polaris retrieves those artifacts into future runs
- Polaris curates accumulated artifacts over time

The goal is a stable control-plane learning boundary that survives manager
replacement.

## Scope Model

Polaris keeps three different concerns separate:

- **workspace knowledge**
  - debugging lessons
  - validation recipes
  - reusable playbooks
  - local workflow patterns
- **user-linked preferences**
  - formatting preferences
  - execution-style preferences
  - durable operator habits
- **identity material**
  - Codex auth/config
  - Claude settings
  - SSH keys

The first two belong to the evolution kernel.
The third does not.

This follows the existing attachment contract:

- `workspace-runtime-state`
  - manager state
  - evolution state
- `user-identity-state`
  - external agent credentials
- `user-ssh-state`
  - SSH identity

## Storage Layout

At the runtime attachment boundary, the current Paseo-backed realization is:

```text
/workspace/state/paseo/
/workspace/state/paseo/evolution/
```

Inside the control plane, Polaris also keeps its own local evolution state for
inspection and bootstrap preparation under:

```text
config/state/evolution/<project>/
  store.db
  bootstrap-context.md
```

The durable learning store is SQLite-backed through `sql.js`.

Current logical tables:

- `execution_events`
  - normalized control-plane execution records
- `artifacts`
  - typed learning artifacts such as:
    - `user-preference`
    - `workspace-playbook`
    - `verified-lesson`
    - `discarded-observation`

## Runtime Contract

The workspace agent contract is no longer a bare `manager: "paseo"` switch.

Polaris now models manager capabilities explicitly:

- event stream support
- transcript replay support
- structured artifact support
- review support
- retrieval support
- curation support
- daemon requirement
- pairing support

For the current implementation, the first concrete manager id is:

- `paseo`

But the evolution kernel is designed to sit above that value, not inside it.

## Bootstrap And Injection

Before `render` or `start`, Polaris prepares a bootstrap context by:

1. Opening the workspace evolution store
2. Retrieving relevant active artifacts for the workspace and selected user
   profile
3. Rendering them into a compact markdown snapshot
4. Writing that snapshot to:
   - control-plane path: `config/state/evolution/<project>/bootstrap-context.md`
   - runtime path: `<evolutionRoot>/bootstrap-context.md`

The runtime receives:

- `POLARIS_EVOLUTION_ROOT`
- `POLARIS_EVOLUTION_CONTEXT_FILE`

This gives the manager and external harnesses an explicit place to read
retrieved lessons from, without requiring Polaris to rewrite their private
configuration or skill directories.

## Automatic Loop

Polaris currently records control-plane lifecycle activity for these commands:

- `render`
- `start`
- `apply`
- `stop`
- `restart`
- `rebuild`
- `status`
- `reconcile`

Each command can open an evolution session and append normalized events such
as:

- `task-started`
- `task-completed`
- `task-failed`

On session finalization, Polaris runs:

1. **review**
   - turns the collected session into typed artifacts
2. **curation**
   - archives duplicates or low-value artifacts
3. **retrieval**
   - makes surviving active artifacts available to future bootstrap preparation

The current reviewer is intentionally simple and rule-based. It proves the loop
shape and storage contract before deeper manager-native transcript integration.

## Lesson-Only Learning

Polaris now treats runtime learning as lesson capture, not skill creation.

The current direction is:

- summarize durable experiences
- store short lessons
- inject recalled lessons later
- avoid autonomous skill generation

This is intentionally narrower than Hermes-style skill evolution. Polaris keeps
the write surface smaller:

- lesson title
- lesson summary
- when-to-use guidance
- retrieval tags
- source metadata

The runtime observer supports explicit trigger markers such as:

- `POLARIS-LEARN-IT`
- `POLARIS-RECALL`
- `POLARIS-DONT-LEARN`
- `POLARIS-EPHEMERAL`

The conservative first policy is:

- trust user-issued learn markers
- automatically summarize meaningful failures and completions
- do not summarize every run

## Runtime Observer

For daemon-backed Paseo workspaces, Polaris now runs a runtime observer inside
the workspace state boundary.

It currently:

- watches daemon-owned agent records under `.paseo/agents`
- writes runtime execution events under `.paseo/evolution/execution-events.jsonl`
- writes runtime lesson artifacts under `.paseo/evolution/artifacts.jsonl`
- refreshes `.paseo/evolution/bootstrap-context.md`
- patches Paseo daemon `appendSystemPrompt` live through supported daemon config
  APIs

That shared daemon prompt patch is the important integration point because it
applies to:

- CLI-created runs
- web-portal-created runs

through the same manager surface.

## Selective Summarization

Polaris now has a path for cheap-model lesson distillation, but it is meant to
be selective rather than always-on.

The intended policy is:

- use a cheap coding-capable summarizer only for explicit learn-triggered runs
  and meaningful success/failure events
- fall back to deterministic lesson summaries when no summarizer is configured

This keeps token usage lower than a system that reflexively summarizes every
turn or creates autonomous skills.

## Retrieval Explainability

Retrieved lessons are now meant to be visible and debuggable rather than
opaque prompt stuffing.

The retrieval path can now record:

- retrieval score
- retrieval reasons
- retrieval timestamp
- prompt text used for matching

Typical retrieval reasons include:

- workspace-scoped
- same user profile
- direct prompt text match
- matched tags
- recently updated

The rendered lesson context can expose these reasons directly so operators can
see why a lesson was selected for a run.

## Curator Policies

Polaris now has explicit curator policy categories rather than only simple
archive behavior:

- **promotion**
  - high-confidence active artifacts are marked as promoted
- **merge**
  - duplicate signatures keep the stronger artifact and archive the weaker one
- **suppression**
  - low-confidence artifacts are suppressed
- **decay**
  - stale low-confidence artifacts are decayed out of active retrieval

The curator writes operator-visible metadata onto artifacts so they can answer:

- why this lesson exists
- why it was retrieved
- why it was suppressed
- why it was promoted, merged, or decayed

## Status Surface

`polaris status <project>` now exposes a summarized evolution view in the
status payload:

- `artifactCount`
- `activeWorkspaceArtifacts`
- `activeUserArtifacts`
- `latestTitles`
- `lastSessionId`

This is meant to answer:

- does this workspace have usable learning state?
- is review producing artifacts?
- did the most recent lifecycle command enter the loop?

## Current Boundaries

The current implementation deliberately does **not** do these things:

- rewrite private Codex or Claude skill directories
- mutate user identity state from reviewer output
- train model weights
- depend on Paseo internals as the source of truth for learning artifacts

Instead, Polaris writes only to its own evolution store and runtime context
files.

## What Is Real Today

Already implemented:

- manager-generic evolution contract
- workspace/user-scoped artifact model
- SQLite-backed store
- bootstrap context generation
- runtime environment injection
- automatic control-plane event capture
- automatic review and curation on lifecycle completion
- status summary exposure

Not yet manager-native:

- deep ingestion of external manager transcript detail
- tool-call-level semantic replay from manager-private stores
- model-based reviewer with stronger validation
- richer trigger-aware lesson extraction from full run transcripts

That distinction matters: the loop is real and functional today, but transcript
fidelity is still control-plane-first rather than manager-internal.

## Files To Read

If you need the implementation entrypoints, start here:

- [README.md](./README.md)
- [runtime-layout.md](./runtime-layout.md)
- [apps/polaris/scripts/evolution/runtime.ts](/home/debian/Projects/geek-env/apps/polaris/scripts/evolution/runtime.ts)
- [apps/polaris/scripts/evolution/store.ts](/home/debian/Projects/geek-env/apps/polaris/scripts/evolution/store.ts)
- [apps/polaris/scripts/evolution/reviewer.ts](/home/debian/Projects/geek-env/apps/polaris/scripts/evolution/reviewer.ts)
- [apps/polaris/scripts/cli/commands/shared.ts](/home/debian/Projects/geek-env/apps/polaris/scripts/cli/commands/shared.ts)
- [apps/polaris/scripts/cli/commands/status.ts](/home/debian/Projects/geek-env/apps/polaris/scripts/cli/commands/status.ts)
