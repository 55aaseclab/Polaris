# Polaris Workflows

Each pack owns its DSL declaration, metadata, examples, skills, and
documentation. Reusable execution code lives once under the repository-level
`tools/` directory.

`autoresearch/` is the first-party Literature Review pack. Its `main.ord`
declaration binds AutoResearch ports to common-tool entries in
`tools/tool-inventory.json`. Polaris discovers it from this directory and
runs `LiteratureReview` as a durable host or mock Vault workflow. There is
no pack-local runner.

`vision-kernel/` is a design sketch of the kernel with orders and stock
ports. It is not a claim that every form in that file is product-wired.
