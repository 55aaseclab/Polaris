# Polaris Workflows

Each workflow owns its DSL declaration, orchestration, workflow-specific
contracts, examples, skills, and documentation. Reusable execution code lives
once under the repository-level `tools/` directory.

`literature-review/` is a workflow, not a tool. Its `main.ord` declaration
binds each execution node to a common-tool entry in `tools/tool-inventory.json`.
