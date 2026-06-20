# Polaris vs Coder

## Short Version

- `Coder`: integrated workspace platform + built-in agent platform
- `Polaris`: workspace platform + external/replaceable agent stack

That difference is intentional.

## Comparison

| Dimension | Polaris | Coder | Edge |
|---|---|---|---|
| Workspace platform | Yes | Yes | `Coder` more mature |
| Control plane | Yes | Yes | `Coder` more mature |
| Multi-backend runtime | Yes | Yes | `Coder` broader |
| Persistence model | explicit attachment classes | infra/template-driven | different strengths |
| State semantics clarity | stronger | less explicit | `Polaris` |
| Product completeness | limited | strong | `Coder` |
| Admin/governance | limited | strong | `Coder` |
| Built-in agent harness | No | Yes | `Coder` only if built-in is desired |

## Agent Platform Model

Polaris will **not** have a built-in agent harness.

Instead, Polaris uses:

- `Paseo` as the manager/orchestrator layer
- replaceable coding harnesses such as `Codex` and `Claude`

So Polaris is intentionally:

- harness-agnostic
- modular
- replaceable at the agent layer

Coder takes a different approach:

- built-in native agent platform
- tighter integration between workspace platform and agent platform

## Clear Conclusion

Coder is the more mature all-in-one workspace platform.

Polaris is a more modular workspace platform with:

- explicit state semantics
- attachment-based persistence
- a replaceable external agent stack

So the most accurate distinction is:

- `Coder`: integrated workspace + built-in agent platform
- `Polaris`: workspace platform + external/replaceable agent stack
