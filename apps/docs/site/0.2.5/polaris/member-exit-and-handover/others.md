# Other Member Exit And Handover Notes

This page keeps the exit-and-handover material that is still mainly technical.

## Scope And Files

Polaris keeps evidence, candidates, committed memory, provider data, and
session snapshots separate.

Important surfaces include:

- runtime evidence
- pending memory changes
- workspace memory
- user memory
- optional provider mirror
- session memory snapshot

## Retrieval Explainability

Retrieved memory entries can record:

- retrieval score
- retrieval reasons
- retrieval timestamp
- prompt text used for matching

## Approval Policy

Polaris supports two write modes:

- `stage`
- `auto`

The current default remains `stage` unless
`POLARIS_MEMORY_WRITE_POLICY=auto` is set.

## Provider Integration

Polaris currently supports a minimal optional provider contract backed by a
local mirror file.

This covers:

- pre-run retrieval
- post-run sync

## Memory Loop

Polaris currently distinguishes:

- lifecycle sessions
- runtime agent sessions

The memory loop is triggered either by lifecycle execution events or by runtime
observation while the workspace is active.
