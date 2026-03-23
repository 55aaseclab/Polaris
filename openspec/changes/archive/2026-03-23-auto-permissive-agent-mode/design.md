## Context

`scripts/new-agent.sh` is the interactive generator for Kata-backed agent containers. It currently embeds agent-specific startup arguments during the agent-selection step, then carries those arguments through generated metadata and into the tmux launch command used when attaching to the running container.

The current behavior is inconsistent with the repository's documented default. Codex always receives its permissive startup flag, while Claude Code asks the user for a separate opt-in. Because the container itself is already isolated by Kata, the default policy should be expressed once at the generator level and then translated into the correct agent-specific flags for each supported CLI.

## Goals / Non-Goals

**Goals:**
- Introduce a single permissive-mode decision in the generator flow, defaulting to enabled.
- Apply the correct permissive startup flag automatically for Claude Code and Codex when the policy is enabled.
- Persist the resulting policy through generated metadata so launch behavior is predictable on deploy and re-attach.
- Align repository documentation with the generated default behavior.

**Non-Goals:**
- Changing Kata runtime configuration or container isolation boundaries.
- Adding support for new agent CLIs beyond Claude Code and Codex.
- Redesigning the overall `new-agent.sh` interaction model beyond the permissive-mode decision.

## Decisions

### Use one generator-level permissive-mode prompt

The generator will ask one question about permissive mode instead of embedding the choice inside each agent branch. This keeps the user-facing policy consistent and avoids agent-specific drift in future edits.

Alternative considered:
- Keep separate per-agent handling. Rejected because it preserves the current inconsistency and makes documentation harder to trust.

### Map permissive mode to agent-specific flags centrally

The script will derive `AGENT_ARGS` from two inputs: selected agent and the permissive-mode boolean. Supported mappings are:
- Claude Code + permissive enabled -> `--dangerously-skip-permissions`
- Codex + permissive enabled -> `--dangerously-bypass-approvals-and-sandbox`
- Any supported agent + permissive disabled -> no permissive flag

This keeps policy separate from vendor-specific CLI syntax while preserving the current launch mechanism.

Alternative considered:
- Store a literal flag string at prompt time. Rejected because it leaks implementation details into the UX and couples the prompt to current CLI flag names.

### Persist the policy in generated metadata

The generated `.env` file should capture the permissive-mode choice in addition to any resolved `AGENT_ARGS`. This makes the generated output self-describing and easier to inspect when debugging an existing deployment.

Alternative considered:
- Persist only `AGENT_ARGS`. Rejected because it obscures user intent and makes a disabled policy indistinguishable from an unsupported agent.

### Keep launch behavior tmux-based

The existing tmux attach path already consumes `AGENT_CMD` and `AGENT_ARGS`. The change should reuse that mechanism rather than introducing a different bootstrap path.

Alternative considered:
- Move agent launch into the container boot command. Rejected because it changes runtime behavior more broadly than required for this feature.

## Risks / Trade-offs

- [CLI flag names change upstream] -> Centralize the mapping so updates are isolated to one part of the generator and reflected in docs together.
- [Users want stricter interactive approval mode] -> Keep the generator-level prompt and allow disabling permissive mode explicitly.
- [Generated metadata drifts from actual launch behavior] -> Write both policy state and resolved arguments from the same decision branch.
- [Shell quoting becomes fragile as more arguments are added] -> Keep the feature limited to single known flags and avoid broadening argument composition in this change.

## Migration Plan

Existing generated agent manifests remain unchanged until users regenerate or update a project through `scripts/new-agent.sh`. New containers will default to permissive mode, while users can explicitly disable it during generation if needed. Rollback is a script reversion plus regenerating affected agent manifests.

## Open Questions

- Whether the summary output should display the permissive-mode policy as a separate line in addition to the resolved launch arguments.
