# Polaris Tool Portal

Status: implemented as one public, inspect-only Polaris registry. The public
portal never executes tools.

The tool portal answers one question: what tools can Polaris workflows refer
to? It is not a workflow runner, tenant console, collaboration hub, or runtime
surface. Polaris is the only publisher.

## Routes

Polaris serves the standalone app from `apps/polaris-tool-portal`:

```text
/tools
/tools/<tool-slug>
/tools/packs/<pack-id>/<pack-flow-slug>
```

`/tools/console` and `/tools/publisher` are not product surfaces. The app
routes them back to the registry for compatibility, and the API exposes no
console or publisher endpoints.

## Registry

`/tools` is public and shows all tools Polaris can currently inspect:

- Common tools from `packages/polaris-tools`;
- Domain Pack flow tools from verified installed [Polaris DSL](./dsl.md)
  `.ord` packs;
- the pack, version, digest, and flow identity for Domain Pack rows;
- every tool call used by each row; and
- the current live state, with live execution still blocked or mocked.

The table is organized as `pack -> flow -> calls` for Domain Pack rows. Common
rows show their own first-party port and mapped tool ID.

`/tools/<tool-slug>` shows the selected Common tool contract: action, port,
effect, risk, executor family, credential policy, schema, gates, and an
optional workflow example.

`/tools/packs/<pack-id>/<pack-flow-slug>` shows the selected Domain Pack flow:
pack, version, digest, flow, inputs, mapped calls, effects, and mapped Common
tool state.

Public routes do not expose credential values, execution URLs, tenant state, or
live run controls.

## Source Of Truth

`packages/polaris-tools` is the canonical first-party catalog. Polaris derives:

- disabled live action catalog entries;
- public Common tool portal rows;
- public Domain Pack flow rows; and
- mock receipts.

Current Common tools:

| Tool | State |
| --- | --- |
| `manual.review` | mock only |
| `vault.artifact.metadata.read` | live blocked |

Domain Pack flow rows are derived from verified Polaris pack projections. They
do not create a second publisher registry.

Current first-party Domain Pack flow:

- Pack: `VaultKnowledgeHealth@1.0.0`
- Flow: `ReviewKnowledgeHealth`
- Mapping: `ArtifactMetadata@1.0.0` ->
  `vault.artifact.metadata.read`
- State: ordinary runs are mock-only. Live read is blocked except the
  operator-admitted metadata candidate path.

## Live Boundary

Adding a live tool later is a Polaris control-plane change. New tools should
reuse the Polaris live tool gateway and join a small executor family, not add
one adapter per tool. Before any tool can execute, Polaris must own durable
admission, idempotency, receipts, reconciliation, budget, kill switch, audit,
rollback, and deployment evidence.

The portal remains inspect-only after a tool becomes live. Live admission must
stay in Polaris operator or product workflow surfaces that own policy,
evidence, and audit.

## Focused Checks

```text
cd polaris
pnpm --filter polaris-tools run typecheck
pnpm --filter polaris-tools test
pnpm --filter polaris-tool-portal run typecheck
pnpm --filter polaris-tool-portal test
pnpm --filter polaris-tool-portal run build
pnpm --filter polaris exec tsx --test tests/polaris-portal.test.ts
git diff --check
```
