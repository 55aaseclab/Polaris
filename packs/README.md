# Polaris Workflows

Each pack owns its DSL declaration, metadata, examples, skills, and
documentation. Reusable execution code lives once under the repository-level
`tools/` directory.

`autoresearch/` is a declaration-only pack. Its `main.ord` declaration binds
the AutoResearch trial ports to common-tool entries in
`tools/tool-inventory.json`; it contains no workflow runner.

`vault-knowledge-health/` is the minimum first-party business pack. It
declares `ReviewKnowledgeHealth` and maps `ArtifactMetadata@1.0.0` to
`vault.artifact.metadata.read`.

`cve-genie-trial/` is the bounded v0.4-trial CVE-Genie fixture.

`vision-kernel/` is a design sketch of the kernel with orders and stock
ports. It is not a claim that every form in that file is product-wired.
