# Polaris Common Tools

This is the single repository-level implementation root for reusable Polaris
tools. A workflow may bind ports to these tools, but it must not own a nested
copy of them. Domain-specific tools are the exception (PRD 3.11.8): they ship
inside their pack under `packs/<pack>/tools/`, their inventory entrypoints
point at pack-local paths, and they resolve straight from the repository
root. This tree stays global: the CLH runtime lives in `packages/llm-harness`,
and the existing autoresearch tools remain here untouched.

`tool-inventory.json` is the checked-in inventory of tool entrypoints,
versions, commands, and capability summaries. It contains no credentials,
tenant state, endpoint publication, or scheduler state.

Each tool owns env, commands, files, and Python requirements in its
`backend.lock.json` under `prerequisites`. Polaristool evaluates those
locks and does not hardcode per-tool env. Python tools must declare
`prerequisites.python.requirements`, even when the list is empty.

Each common tool also owns `check-setup`. `ops tool-precheck` and the
portal Tools page at `/settings/tools` run that script. The page shows
the same printed lines and a recheck control. Run `./check-setup` in a
tool directory, or
`pnpm --dir apps/polaris run polaris -- ops tool-precheck`.

Each tool owns its instruction-layer skill under `<tool>/skills/` when it
has one. There is no repository-level `skills/` tree. The literature-review
workflow uses the collection, source, review, intelligence-analysis, Codex,
browser, and report-writing tools from this directory. Its orchestration and
DSL declaration live in `packs/autoresearch/`.

Common tools are implementation code, not a second control plane. Integrated
execution remains admitted, leased, budgeted, auditable, and recoverable only
through Polaris durable jobs.

## Business tools

Business implementations migrated from the former Wanghai tool tree live under
`google-map`, `industry-directories`, `logistics-management`, `outreach`,
`social-media`, and `social-publish`.

These tools use `POLARIS_BUSINESS_*` configuration in standalone local mode.
Integrated mode is fail-closed: writes, external requests, publishing, SMTP,
and other side effects require a Polaris durable action service. The wrappers
may still expose version, validation, and other bounded read-only commands.

Some migrated documents intentionally retain `wanghai.*` schema identifiers.
Those are versioned legacy contracts for existing workspace data, not a
runtime dependency on the Wanghai repository.

## Legacy names

The former `wanghai-content-production` and `wanghai-product-video` wrappers
are now `polaris-content-production` and `polaris-product-video`. The Chinese
logistics note was consolidated into `logistics-management/README.zh-CN.md`.
The former tool-specific ignore rules are covered by the repository root
`.gitignore`; generated backends and run state are not migrated as source.
