# Documentation System

This is the operating rule for a solo maintainer. Keep the system small enough
to review in one sitting: each fact has one canonical owner, each release claim
has one evidence record, and each batch leaves a traceable commit.

## Ownership

| Material | Canonical location | Update when |
| --- | --- | --- |
| Clone, setup, and repository commands | Source repository root `README.md` | A checkout or local workflow changes |
| Polaris source release notes | Polaris repository root `CHANGELOG.md` | A versioned source behavior changes |
| Agent instructions and executable contracts | Source-local `AGENTS.md`, skills, schemas, and tool READMEs | An agent-facing contract changes |
| Polaris product and technical reference | `site/polaris/` | A product behavior or interface changes |
| Control-plane responsibility boundary | `site/documentation-system/` | Polaris ownership changes |
| Deployment and incident procedures | `site/operations/` | A deployed topology or recovery procedure changes |
| Original 0.3 gates and evidence | `site/operations/polaris-release/` | The foundational 0.3 gate record changes |
| Current release scope and state | `site/operations/polaris-0.3.4/` | The active 0.3.4 boundary, status, or next-work decision changes |

## Responsibility

Polaris owns user identity, tenant and vault ownership, roles, lifecycle,
ingress, rate limits, quotas, durable jobs, and durable audit. The private surface
source repository and standalone documentation are archived. Any retained
compatibility boundary is documented only in Polaris, which remains the active
product and control-plane owner.

Canonical published links:

- [Polaris](https://www.jianxiaoyitech.com/docs/polaris/)
- [Operations](https://www.jianxiaoyitech.com/docs/operations/)
- [Documentation System](https://www.jianxiaoyitech.com/docs/documentation-system/)
- [Polaris 0.3 release records](https://www.jianxiaoyitech.com/docs/operations/polaris-release/)
- [Polaris 0.3.4 current state](https://www.jianxiaoyitech.com/docs/operations/polaris-0.3.4/)

Do not create a second command reference just to make a page feel complete.
Link to the canonical owner or describe the boundary at a higher level.

## Decision Tree

Before editing, classify the fact:

1. If it is needed to clone or run one repository, edit that repository's root
   README.
2. If it is an executable agent, skill, schema, or tool contract, edit the
   source-local owner.
3. If it crosses Polaris and a retained surface, edit the relevant product or
   operations page here.
4. If it claims that a release gate passed, add the commit, test result,
   environment, timestamp, and redacted artifact to the release evidence page.
5. If it is historical, keep it under an explicitly dated or named section;
   do not silently replace the old account.

## Small-Batch Routine

For an implementation change:

1. Change the implementation and focused tests in the owning repository.
2. Update only the nearest architecture, operations, or README page whose
   contract changed.
3. Review the staged diff for tenant, path, secret, rollback, and compatibility
   regressions.
4. Run `git diff --check`, the focused tests, and `pnpm run check` when site
   content changed.
5. Commit the source and documentation in independently reviewable batches;
   record the source commit in the release plan.

For a release or incident, record the environment, UTC timestamp, commit or
image digest, command or scenario, result, owner, and redacted artifact
location. A local test is implementation evidence, not deployed proof. A
failed, missing, or stale result keeps its gate open.

## Site Layout

- `site/polaris/`: Polaris product and technical reference
- `site/operations/`: deployment, gateway, incident, and release records
- `site/business-model/`: lower-priority reference

The VitePress sidebar and top navigation use the fixed directory configuration
in `site/.vitepress/config.ts`. The configuration names the supported sections,
page order, and nested group labels. Page titles come from each file's first H1,
links come from file paths, and nested directories become collapsed groups.
When Markdown content is added, moved, or renamed, update the configuration in
the same change.

## Privacy And Naming

Use synthetic tenants, users, workspaces, and artifact names in committed
material. Never commit credentials, cookies, signed assertions, customer data,
unredacted host output, or deployment secrets. Keep internal release-directory
names out of Polaris source code and executable configuration.

## Verification

From this repository run:

```bash
pnpm install
pnpm run check
```

Do not mark a release gate complete from a local build alone. Pair code checks
with the deployed evidence required by the release record.
