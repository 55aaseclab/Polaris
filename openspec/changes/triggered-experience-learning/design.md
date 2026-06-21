## Context

Polaris already has a universal evolution kernel and a runtime observer that can capture daemon-observed agent outcomes, write runtime artifacts, and patch Paseo daemon `appendSystemPrompt` so both web-portal and CLI launches inherit the same recalled context. However, the current lesson generation is still shallow and implicit: it derives only coarse success/failure summaries from agent status changes, and it does not distinguish between operator-intended learning moments and incidental run noise.

The user direction is narrower than Hermes-style autonomous skill creation. Polaris should summarize experiences, not synthesize or promote reusable skills. The desired model is:

- explicit learning triggers such as `POLARIS-LEARN-IT`
- optional explicit recall via `POLARIS-RECALL`
- conservative persistence defaults
- cheap-model lesson distillation only when needed
- shared injection through the daemon so CLI and web portal behave the same

## Goals / Non-Goals

**Goals:**
- Define a lesson-only learning protocol with explicit trigger markers.
- Add a structured lesson schema with summary, usage guidance, tags, source metadata, and confidence.
- Allow a cheap coding-capable summarizer model to distill durable lessons only for selected runs.
- Keep daemon-level `appendSystemPrompt` as the shared recall path for both Paseo CLI and web-portal runs.
- Preserve Polaris' separation between workspace knowledge, user-linked preferences, and identity material.

**Non-Goals:**
- Autonomous skill creation, skill promotion, or self-editing skill directories.
- Full transcript replay, tool-call semantic analysis, or large-model reflective review for every run.
- Mutating Codex or Claude private config trees to encode learned behavior.
- Making every run persist a lesson automatically.

## Decisions

### Decision: Polaris learns lessons, not skills

The durable object is a `lesson`, not a `skill`. A lesson is a short summarized experience with:
- title
- summary
- when-to-use guidance
- tags
- source metadata
- scope
- confidence

Rationale:
- This matches the operator goal directly.
- It avoids the token and governance complexity of autonomous skill creation.
- It is easier to audit, decay, suppress, and retrieve safely.

Alternatives considered:
- Hermes-style autonomous skill creation.
  Rejected because it is a broader system than needed and adds more hallucination and lifecycle risk.
- Keep only the current generic `workspace-playbook` summaries.
  Rejected because they are too coarse to support explicit trigger semantics and selective recall.

### Decision: Trigger markers control lesson persistence and recall

The runtime protocol will recognize these markers:
- `POLARIS-LEARN-IT`
- `POLARIS-RECALL`
- `POLARIS-DONT-LEARN`
- `POLARIS-EPHEMERAL`

The first rollout will trust user-originated trigger markers and remain conservative about agent-originated ones.

Rationale:
- Explicit triggers keep trust high and token spend low.
- Operators can mark durable experiences intentionally.
- Recall becomes debuggable because it has a clear trigger surface.

Alternatives considered:
- Implicitly summarize every run.
  Rejected because it creates too much noise and unnecessary token spend.
- Purely automatic learning with no trigger syntax.
  Rejected because it is harder to control and explain.

### Decision: Cheap-model summarization is optional and event-driven

Polaris will use a cheap coding-capable summarizer only when:
- a run is marked with `POLARIS-LEARN-IT`
- a meaningful failure should be distilled
- a meaningful successful completion should be distilled

Fallback remains deterministic rule-based summarization when model summarization is unavailable.

Rationale:
- This limits extra token usage.
- It improves lesson quality beyond raw status/error strings.
- It prevents "double token usage" on every single run.

Alternatives considered:
- Use an expensive model for every run.
  Rejected because the cost model is poor and the value is low for routine runs.
- Stay fully rule-based forever.
  Rejected because trigger-based experience summaries benefit from model distillation.

### Decision: Paseo daemon config is the shared injection surface

Lesson recall will continue to flow through Paseo daemon `appendSystemPrompt`, patched live via supported daemon config APIs.

Rationale:
- It applies to both web portal and CLI runs by construction.
- It avoids wrapping only one entrypoint.
- The daemon already supports live `appendSystemPrompt` changes.

Alternatives considered:
- Wrap `paseo run` only.
  Rejected because web-portal runs would miss the same recall path.
- Patch provider-specific configs like `.codex/config.toml`.
  Rejected because Polaris should not encode learning by mutating private harness config.

### Decision: Runtime observer remains the first shared capture path

The observer will remain daemon-state-driven in the first rollout:
- agent JSON records under `.paseo/agents`
- daemon config patching
- runtime artifacts under `.paseo/evolution`

This change will enrich what the observer captures and summarizes, rather than replacing it with a fully transcript-native pipeline immediately.

Rationale:
- It is already shared across both CLI and web portal launches.
- It produces useful lessons today.
- It preserves momentum while leaving space for deeper transcript-aware capture later.

Alternatives considered:
- Require full transcript ingestion first.
  Rejected because it delays the useful, explicit lesson-learning behavior.

## Risks / Trade-offs

- [Trigger markers may be overused and create noisy lessons] → Start with user-originated trigger trust and conservative automatic capture.
- [Cheap summarizer output may still hallucinate] → Require compact structured output and retain source/error metadata for audit.
- [Daemon prompt injection could become bloated] → Cap retrieved lessons and keep summaries short.
- [Observer polling may miss fine-grained semantics] → Accept coarse capture initially and leave transcript-aware enrichment as a later upgrade.
- [Web portal and CLI may still diverge in provider-specific behavior] → Keep the injection path shared at the daemon layer and treat provider/runtime differences separately.

## Migration Plan

1. Introduce a lesson schema and trigger vocabulary in the evolution layer.
2. Update the runtime observer so it can detect learning/recall trigger markers and call a cheap summarizer only for selected events.
3. Keep the observer writing runtime artifacts and refreshing `bootstrap-context.md`.
4. Continue patching daemon `appendSystemPrompt` live so both web-portal and CLI runs inherit the same recalled lesson set.
5. Add retrieval ranking and caps so injected lessons remain short and relevant.

Rollback:
- Disable model-based summarization and fall back to the existing rule-based observer.
- Clear daemon `appendSystemPrompt` if retrieval injection needs to be disabled without removing runtime artifact history.

## Open Questions

- What is the exact source for trigger detection in real runs: initial prompt only, agent title, timeline text, or all three?
- Should `POLARIS-RECALL` force retrieval only for the current run, or should it also update the persisted appended prompt?
- Should failure-only automatic lessons remain enabled when no explicit trigger is present, or should all persistence become opt-in?
- Which cheap model should be the default summarizer provider for lesson distillation?
