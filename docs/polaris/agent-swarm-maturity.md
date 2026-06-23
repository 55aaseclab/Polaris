# Agent Swarm Maturity

## Short Version

For `Agent Swarm`, the strongest product comparison is `Coder`.
Hermes is relevant as a harness reference, not a workspace platform reference.

## Polaris Today

- Polaris intentionally does not provide a built-in coding harness.
- `Paseo` is the manager/orchestrator layer.
- `Codex` and `Claude` are external harnesses.
- Polaris assembles identity, SSH, runtime state, readiness, and manager
  surfaces around them.
- The current model is explicitly replaceable.

## Coder Today

Coder is ahead here as a product.

Its current docs and product direction show:

- built-in `Coder Agents`
- UI and API for delegating work
- template-driven provisioning for agent runs
- centralized identity and governance
- MCP and skill controls
- native self-hosted agent workflow story

## Gap

Coder is much more mature if the goal is:

- native agent UX
- built-in orchestration
- built-in governance
- productized multi-agent operator experience

Polaris is still an integration substrate here.

## Polaris Strength

Polaris is stronger if you care about:

- harness replaceability
- manager replaceability
- keeping the agent layer out of the control plane core

That is strategically valuable, but product maturity is still behind Coder.

## Where Hermes Enters

Hermes is relevant here as a harness reference rather than a workspace platform
reference.

It is useful for:

- agent memory
- evolving skills
- autonomous review/feedback loops
- persistent harness behavior

If Coder is the comparison for "native agent platform", Hermes is the
comparison for "what a mature harness can do once it has a real memory and
review loop".

## TODO Toward Coder Maturity

- Define a real manager contract surface beyond today's Paseo-first reality.
- Add first-class multi-agent orchestration concepts instead of only external
  runtime bootstrapping.
- Add control-plane views for manager sessions, task history, and handoffs.
- Add operator controls for allowed harnesses, allowed skills, and allowed MCP
  surfaces.
- Add swarm coordination primitives:
  task graph, delegation, review, merge, and attribution.
- Add stronger identity and audit semantics for "who did what" across agents.
