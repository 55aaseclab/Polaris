## Why

Polaris now has a working evolution kernel, but the current learning loop is still too implicit and too shallow: it summarizes coarse success/failure state rather than explicitly capturing durable operator experiences. We need a narrower, cheaper learning model that stores lessons instead of generating skills, and that can be triggered intentionally during real runs.

## What Changes

- Introduce explicit lesson-learning triggers such as `POLARIS-LEARN-IT`, `POLARIS-RECALL`, `POLARIS-DONT-LEARN`, and `POLARIS-EPHEMERAL`.
- Add a lesson-centric artifact model that stores short summaries, usage guidance, and retrieval tags instead of autonomous skill definitions.
- Add a lightweight summarization path that can use a cheap coding-capable model only when a run is explicitly marked for learning or when a meaningful success/failure should be distilled.
- Make daemon-level context injection the shared retrieval path so both Paseo CLI runs and web-portal runs receive the same recalled lessons.
- Add policy for when lessons are created automatically versus only by explicit trigger, with conservative defaults that prioritize user-issued learning signals.

## Capabilities

### New Capabilities
- `experience-learning`: Explicit trigger-based lesson capture, summarization, storage, and retrieval for workspace and user-scoped experiences.

### Modified Capabilities
- `workspace-orchestration`: Agent runs gain shared daemon-level lesson recall behavior across both CLI and web-portal entrypoints.
- `workspace-runtime-contract`: Runtime evolution state now includes daemon-observed lesson summaries and shared appended prompt refresh semantics.

## Impact

- Affected code:
  - `scripts/polaris/evolution/**`
  - `scripts/polaris/backends/docker/render.ts`
  - future Paseo daemon integration helpers and summarizer wiring
- Affected systems:
  - Paseo daemon config (`appendSystemPrompt`)
  - runtime evolution state under `.paseo/evolution/`
  - user/operator prompt conventions for explicit learning triggers
- Affected behavior:
  - future runs may receive recalled lessons automatically or via explicit recall markers
  - summarization token usage is introduced only for selected learning events, not every run
