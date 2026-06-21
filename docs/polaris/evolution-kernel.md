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

That distinction matters: the loop is real and functional today, but transcript
fidelity is still control-plane-first rather than manager-internal.

## Files To Read

If you need the implementation entrypoints, start here:

- [README.md](./README.md)
- [runtime-layout.md](./runtime-layout.md)
- [scripts/polaris/evolution/runtime.ts](/home/debian/Projects/geek-env/scripts/polaris/evolution/runtime.ts)
- [scripts/polaris/evolution/store.ts](/home/debian/Projects/geek-env/scripts/polaris/evolution/store.ts)
- [scripts/polaris/evolution/reviewer.ts](/home/debian/Projects/geek-env/scripts/polaris/evolution/reviewer.ts)
- [scripts/polaris/cli/commands/shared.ts](/home/debian/Projects/geek-env/scripts/polaris/cli/commands/shared.ts)
- [scripts/polaris/cli/commands/status.ts](/home/debian/Projects/geek-env/scripts/polaris/cli/commands/status.ts)
