# Polaris Common Tools

This is the single repository-level implementation root for reusable Polaris
tools. A workflow may bind ports to these tools, but it must not own a nested
copy of them.

`tool-inventory.json` is the checked-in inventory of tool entrypoints,
versions, commands, and capability summaries. It contains no credentials,
tenant state, endpoint publication, or scheduler state.

The literature-review workflow uses the collection, source, review,
intelligence-analysis, Codex, browser, and report-writing tools from this
directory. Its orchestration, DSL declaration, skills, and local CLI live in
`workflows/literature-review/`.

Common tools are implementation code, not a second control plane. Integrated
execution remains admitted, leased, budgeted, auditable, and recoverable only
through Polaris durable jobs.
