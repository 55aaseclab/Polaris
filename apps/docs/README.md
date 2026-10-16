# Polaris Documentation

This repository builds the official product and operations documentation site
for Polaris. The published entry point is
`https://www.jianxiaoyitech.com/docs/`.

The site is a small, curated map. It is not a mirror of either source
repository and it is not a release certificate.

## Start Here

- [Polaris product docs](site/polaris/index.md) cover the workflow execution
  platform, control plane, and cross-repository architecture. The Domain Pack
  language lives on [Polaris DSL](site/polaris/dsl.md).
- [Development](site/development/index.md) is the path for the PRD,
  deployment, gateway, and incident records.

## Local Commands

```bash
pnpm install
pnpm run docs:dev
pnpm run docs:check
```

`pnpm run docs:check` builds VitePress and validates the generated sidebar
routes and Mermaid output. It does not start Polaris, deploy to a host, or
establish release evidence.

The sidebar and top navigation use the fixed directory configuration in
`site/.vitepress/config.ts`; add new pages to that configuration explicitly.

## Canonical Ownership

| Content | Canonical owner | Rule |
| --- | --- | --- |
| Clone, setup, and source-local commands | `polaris/README.md` | Keep the first-run path beside the code it starts. |
| Agent instructions, skills, schemas, and tool contracts | The owning source repository | Keep executable contracts next to their implementation. |
| Product, cross-repository architecture, and policy boundaries | `site/polaris/` and `site/development/` | Link to the canonical page instead of copying commands. |
| Product scope, priorities, and requirements | `site/development/prd.md` | The PRD is the single ground truth; fix the PRD first on conflict. |
| Deployment and incident records | `site/development/` | Separate implementation claims from deployed evidence. |

Repository READMEs link back to the published product and development pages.
When a source-local command changes, update the source README; when ownership
or integration behavior changes, update this site and the PRD if scope
changes.

## Solo-Maintainer Rule

Use one small change batch, one canonical owner, and one verification result.
For product scope and priorities, read the
[Polaris PRD](site/development/prd.md).

Do not commit customer data, credentials, cookies, signed assertions,
unredacted host output, or deployment secrets here. Keep failed or missing
release evidence explicitly open.
