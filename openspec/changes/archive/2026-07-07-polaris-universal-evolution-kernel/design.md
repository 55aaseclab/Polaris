## Context

Polaris now models workspaces as first-class control-plane objects with explicit workspace profiles, user profiles, attachment classes, runtime contracts, backend observations, drift synthesis, and reconcile planning. At the same time, the current runtime model still treats Paseo as a special-case manager in several critical places: durable runtime state validation requires a Paseo path, runtime assembly checks surface `paseo` as a named target, and agent integration is expressed as `manager: "none" | "paseo"`.

That shape is good enough for the current single-manager runtime, but it blocks a reusable learning layer. If learning, review, and retrieval are implemented directly against Paseo internals, Polaris will have to re-implement the same system for every future manager. The new design introduces a Polaris-native evolution kernel that sits above manager-specific runtimes and consumes a manager adapter contract rather than a Paseo-only API.

## Goals / Non-Goals

**Goals:**
- Define a manager-agnostic evolution kernel that Polaris owns, even when Paseo remains the first concrete manager.
- Split workspace-scoped operational knowledge from user-scoped preference and identity knowledge.
- Keep evolution state inside declared durable attachments, with workspace-local knowledge stored in workspace runtime state and user-linked preference recall indexed by user profile identity.
- Replace hard-coded Paseo assumptions in workspace validation, runtime assembly checks, and daemon readiness semantics with manager capability-driven checks.
- Establish a path for reviewer, retriever, and curator services to operate on normalized execution records rather than directly mutating external agent private state.

**Non-Goals:**
- Build multi-tenant authorization or cross-user access control.
- Replace Paseo as the default manager in this change.
- Directly write learning artifacts into external Codex or Claude private skill directories.
- Implement model-weight training, RL pipelines, or offline fine-tuning infrastructure.

## Decisions

### Decision: Polaris owns the evolution kernel and managers provide adapters

The evolution system will be defined in Polaris as a control-plane service, not as a manager-specific plugin. Paseo becomes the first `AgentManagerAdapter` implementation.

Rationale:
- Polaris already owns workspace identity, runtime contracts, and durable attachment semantics.
- Learning artifacts should survive manager replacement.
- This preserves one boundary: managers execute and emit events; Polaris stores, reviews, retrieves, and curates.

Alternatives considered:
- Implement learning directly inside Paseo and let Polaris consume it.
  Rejected because it would lock workspace learning to one manager and duplicate the problem for the next manager.
- Store only opaque manager-native artifacts and avoid a Polaris model.
  Rejected because retrieval, curation, and portability require normalized data.

### Decision: Evolution state is a first-class workspace-runtime-state tenant

Workspace-local evolution data will live under the workspace-scoped durable runtime state attachment, alongside but separate from manager runtime files.

Proposed layout:
- `workspace-runtime-state/manager/`
- `workspace-runtime-state/evolution/`
  - `store.db`
  - `events/`
  - `reviews/`
  - `exports/`

Rationale:
- Operational lessons and project-specific playbooks are workspace-scoped, not user-scoped.
- The attachment model already says workspace runtime state is durable and non-shared.
- This avoids coupling learning persistence to ephemeral runtime home assembly.

Alternatives considered:
- Store evolution data in `workspace-data`.
  Rejected because workspace data should remain user project content, not control-plane operational state.
- Store evolution data in user identity state.
  Rejected because workspace-local lessons must not leak across unrelated workspaces by default.

### Decision: User preferences are linked by user profile, not by runtime UNIX user

The evolution kernel will index user-linked preferences and long-lived operator habits by `userProfile.id`, not by runtime user strings like `root`.

Rationale:
- Polaris has already introduced a first-class user profile model.
- Runtime UNIX user is not a stable human identity.
- Preference recall should follow the operator across workspaces while still remaining separable from workspace-local playbooks.

Alternatives considered:
- Key preferences by runtime user or backend container user.
  Rejected because that leaks implementation detail into identity and breaks immediately for shared runtime users.
- Keep all preferences workspace-local.
  Rejected because durable operator preferences are intentionally cross-workspace.

### Decision: Manager capability negotiation replaces Paseo-only runtime assumptions

`WorkspaceAgentContract` will be generalized from a hard-coded `manager: "none" | "paseo"` model to a manager contract that declares:
- manager id
- contract version
- capability flags
- readiness surfaces
- transcript/event replay support
- structured artifact support

The runtime controller will inspect manager-specific readiness surfaces through a normalized observation contract rather than by checking for `paseo` by name.

Rationale:
- Today’s hard-coded Paseo checks block reuse.
- Readiness and drift should be contract-driven.
- The backend drivers already consume `WorkspaceSpec`; this extends the same pattern to manager behavior.

Alternatives considered:
- Add `"future-manager"` enum values later but keep current Paseo-specific checks.
  Rejected because that preserves the wrong abstraction and creates fake generality.

### Decision: Reviewer output is structured and constrained

Reviewer runs will produce structured evolution artifacts with explicit kinds:
- `user-preference`
- `workspace-playbook`
- `verified-lesson`
- `discarded-observation`

Reviewers may propose artifacts, but they do not directly mutate external harness private state. They write only to the evolution store.

Rationale:
- Hermes works because its review loop has a bounded write surface.
- Structured output supports retrieval, promotion, curation, and explainability.
- It prevents accidental corruption of Codex/Claude private state.

Alternatives considered:
- Let reviewers directly rewrite external skill directories.
  Rejected because Polaris does not own those private runtimes and cannot guarantee safety or portability.

### Decision: Curator governs promotion, merge, and decay

Not every observation becomes durable knowledge. The curator will:
- deduplicate similar lessons
- merge overlapping workspace playbooks
- decay stale or contradicted items
- archive low-confidence or obsolete items
- promote only verified lessons into high-priority retrieval

Rationale:
- Raw accumulation causes drift and contradiction.
- Hermes’ strongest idea is not just “save more”; it is “save, then curate”.

Alternatives considered:
- Keep all reviewer outputs forever.
  Rejected because the store becomes noisy and retrieval quality collapses.

## Risks / Trade-offs

- [A manager-generic contract adds complexity] → Start with Paseo as the only adapter and keep the contract minimal: event stream, transcript fetch, readiness, and task invocation.
- [Workspace-local evolution data may still grow too quickly] → Use SQLite + typed artifact tables + curator-driven decay instead of raw append-only JSON only.
- [User preference recall could bleed into the wrong workspace behavior] → Keep user-linked preferences separate from workspace playbooks and apply retrieval scopes explicitly.
- [Backend parity will lag while pod/docker/kubevirt converge] → Make evolution storage part of the attachment contract so every backend realizes the same logical state even if physical mount mechanics differ.
- [Reviewer agents can hallucinate bad lessons] → Require structured artifact typing, confidence tagging, and curator verification before high-priority promotion.

## Migration Plan

1. Generalize `WorkspaceAgentContract` and backend/runtime observation types so manager-specific semantics are represented through capability-bearing contracts rather than the literal `paseo` key.
2. Introduce evolution-specific durable paths within `workspace-runtime-state` and update validation/docs accordingly.
3. Add a Paseo adapter that translates manager events, transcripts, and readiness into the normalized evolution contract.
4. Add the evolution store, retrieval pipeline, and reviewer/curator services behind feature-gated control-plane entrypoints.
5. Update runtime assembly and drift synthesis so workspaces report manager-generic readiness while still surfacing Paseo as the first concrete adapter implementation.
6. Backfill existing Paseo-based workspace specs so they declare the new evolution-capable runtime contract without changing their operator-facing backend selection.

Rollback:
- The evolution kernel can be disabled at the Polaris layer without removing manager runtime state.
- Existing Paseo runtime behavior remains usable because the first rollout adds a compatibility adapter rather than replacing the manager itself.

## Open Questions

- Should user-linked preference artifacts live in the same SQLite store with a `userProfileId` scope, or in a separate user-scoped store that workspace retrieval consults?
- What is the minimal event contract a non-Paseo manager must satisfy to participate in evolution: timeline-only, or full transcript replay plus structured tool-call records?
- Should Polaris expose reviewer/curator control as CLI subcommands in the first iteration, or keep them internal until the artifact model stabilizes?
