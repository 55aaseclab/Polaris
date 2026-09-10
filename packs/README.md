# Polaris Workflows

Each pack owns its DSL declaration, metadata, examples, skills, and
documentation. Reusable execution code lives once under the repository-level
`tools/` directory.

`autoresearch/` is a declaration-only pack. Its `main.ord` declaration binds
the AutoResearch trial ports to common-tool entries in
`tools/tool-inventory.json`; it contains no workflow runner.
