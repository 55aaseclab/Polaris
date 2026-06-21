# Polaris vs Coder

## Short Version

- `Coder`: integrated workspace platform + built-in agent platform
- `Polaris`: workspace platform + external/replaceable agent stack

That difference is intentional.

Today, the practical distinction is:

- `Coder` is still the more complete all-in-one product
- `Polaris` now has a usable multi-backend workspace control plane, but keeps
  the agent layer intentionally replaceable

## Comparison

| Dimension | Polaris | Coder | Edge |
|---|---|---|---|
| Workspace platform | Yes | Yes | `Coder` more mature |
| Control plane | Yes | Yes | `Coder` more mature |
| Multi-backend runtime | `pod`, `docker`, `kubevirt-vm` | Yes | `Coder` broader |
| Lifecycle surface | `create`, `render`, `apply`, `start`, `stop`, `status`, `logs` | Yes | `Coder` more mature |
| Docker-first local path | Yes | Yes | different strengths |
| Persistence model | explicit attachment classes | infra/template-driven | different strengths |
| State semantics clarity | stronger | less explicit | `Polaris` |
| Admin/governance | limited | strong | `Coder` |
| Built-in agent harness | No | Yes | `Coder` only if built-in is desired |
| Agent replaceability | strong | weaker | `Polaris` |

## Current Polaris Position

Polaris is now credible as a workspace control plane:

- Docker is the clean default onboarding path
- the CLI can drive `pod`, `docker`, and `kubevirt-vm`
- the control plane synthesizes backend status, runtime assembly state, daemon
  readiness, and drift
- backend-specific generated artifacts remain outputs, not the source of truth

What Polaris still does **not** try to be:

- a built-in coding harness
- a fully integrated agent product like Coder
- an admin/governance-heavy enterprise platform

So the comparison should not collapse into "Polaris is a smaller Coder." It is
closer to:

- workspace control plane first
- explicit persistence/runtime semantics
- external agent layer by design

## Agent Platform Model

Polaris will **not** have a built-in agent harness.

Instead, Polaris uses:

- `Paseo` as the manager/orchestrator layer
- replaceable coding harnesses such as `Codex` and `Claude`

The practical contract is:

- Polaris assembles the workspace and bootstraps external agent credentials
- `Paseo` provides the workspace-local daemon/orchestration layer
- `Codex` and `Claude` remain external harnesses, not Polaris-native features

So Polaris is intentionally:

- harness-agnostic
- modular
- replaceable at the agent layer

Coder takes a different approach:

- built-in native agent platform
- tighter integration between workspace platform and agent platform

## Clear Conclusion

Coder is the more mature all-in-one workspace platform with the stronger
built-in product story.

Polaris is now a usable workspace platform with:

- a real multi-backend lifecycle surface
- Docker-first onboarding
- explicit state semantics
- attachment-based persistence
- a replaceable external agent stack

So the most accurate distinction is:

- `Coder`: integrated workspace + built-in agent platform
- `Polaris`: workspace platform + external/replaceable agent stack
