## Context

`geek-env` already uses a single entrypoint, `scripts/agentctl.py`, and already persists project configuration under `config/<backend>/specs/` before rendering `config/<backend>/generated/` manifests. That is a strong foundation, but the current architecture still treats backend manifests as the primary product and treats lifecycle, status, bootstrap repair, and runtime cleanup as secondary concerns embedded in backend-specific branches. The new direction is to replace the Python entrypoint with a TypeScript control plane so the orchestration layer can be decomposed into workspace, config, backend, lifecycle, health, and output modules.

The codebase now spans multiple execution modes with materially different runtime behavior: pod-based environments, kubevirt-vm environments, and a docker path. At the same time, the system carries runtime invariants that are not backend-specific, such as path conventions, ownership and permission rules, durable state preservation, daemon readiness, and safe cleanup of stale runtime artifacts. Those invariants need to be expressed as workspace-level orchestration behavior rather than scattered bootstrap logic.

The project constraints are explicit:

- The unified source of truth moves from `scripts/agentctl.py` to `scripts/agentctl.ts`.
- Backend-specific rules belong in backend-specific spec files.
- Generated manifests are outputs, not hand-maintained assets.
- When persisted state causes restart issues, cleanup must be limited to stale runtime artifacts and must not reset durable state.
- Old docker runtime content should be preserved as packaged legacy material during the migration rather than being rewritten immediately.

## Goals / Non-Goals

**Goals:**

- Make `workspace` a first-class orchestration object inside a TypeScript `agentctl` control plane, distinct from any specific manifest format.
- Separate normalized workspace planning from backend realization so pod, kubevirt-vm, and docker paths share one orchestration model.
- Define a deterministic runtime contract for managed workspaces, especially around structural invariants, durable state, and stale runtime artifacts.
- Add explicit workspace lifecycle semantics and status reporting so operators can reason about `create`, `start`, `stop`, `restart`, `rebuild`, `status`, and `reconcile` as workspace operations.
- Keep backend-specific implementation details behind driver boundaries rather than open-coded branching spread across the entrypoint.
- Establish a durable TypeScript module layout so future orchestration work does not collapse back into one large script.

**Non-Goals:**

- Replacing the orchestration layer with Terraform or another external provisioning framework.
- Building a web UI or multi-tenant control plane in this change.
- Redesigning agent harness or model orchestration behavior.
- Changing durable workspace contents as part of runtime recovery.
- Hand-editing generated Kubernetes or KubeVirt manifests as the steady-state workflow.
- Rewriting the old docker runtime content during the initial TypeScript migration.

## Decisions

### Decision: Replace the Python entrypoint with a TypeScript CLI control plane

The orchestration source of truth moves to `scripts/agentctl.ts`, with implementation split under `scripts/agentctl/` by concern. The Python script is no longer the long-term control-plane home.

Planned layout:

```text
scripts/
  agentctl.ts
  agentctl/
    cli/
      main.ts
      commands/
    core/
    config/
    backends/
      pod/
      kubevirt/
      docker/
        legacy/
    output/
    utils/
```

Rationale:

- The change is architectural, not cosmetic. A TypeScript migration only makes sense if it introduces a cleaner control-plane structure.
- This layout creates stable boundaries for future backend, lifecycle, and health extensions.

Alternatives considered:

- Keep Python and modularize it further. Rejected because the desired steady-state is a TypeScript CLI, and postponing that just increases migration cost.
- Create a single `agentctl.ts` file without module structure. Rejected because it reproduces the same structural problem in a different language.

### Decision: Introduce a normalized workspace object model inside the TypeScript control plane

The TypeScript control plane will manage a workspace object with identity, backend selection, storage policy, runtime configuration, connectivity, lifecycle policy, and health policy. Saved project config remains the input, but render/apply paths become downstream consequences of a normalized workspace plan rather than the primary abstraction.

Rationale:

- This matches how the repo is already used operationally: operators reason about a managed environment, not just a YAML file.
- It creates one place to encode behavior that must hold across backends.

Alternatives considered:

- Keep extending the current per-backend branching model. Rejected because every new lifecycle or runtime invariant multiplies backend-specific logic.
- Promote generated manifests to first-class state. Rejected because generated outputs are intentionally not hand-maintained and cannot encode all workspace lifecycle intent.

### Decision: Reorganize config layout around backend kinds and pod profiles

Config and generated output will be reorganized around stable orchestration concepts:

```text
config/
  specs/
    base/
    pod/
      profiles/
        gvisor.yaml
        kata.yaml
      projects/
    kubevirt/
      projects/
    docker/
      projects/
  generated/
    pod/
    kubevirt/
    docker/
  state/
```

Pod isolation variants such as `gvisor` and `kata` are modeled as pod profiles, not top-level backend kinds.

Rationale:

- `gvisor` is not a durable top-level backend category; it is a pod execution profile.
- This matches the orchestration model more closely than naming directories after one current runtime profile.

Alternatives considered:

- Keep `config/gvisor` as the primary long-term top-level axis. Rejected because it bakes a profile into the config taxonomy.
- Flatten everything into per-project files. Rejected because it obscures defaults, overlays, and backend-specific rules.

### Decision: Model backends as drivers behind a common orchestration interface

The orchestration layer will plan against a common workspace model and delegate realization and inspection to backend drivers. The primary backend kinds are `pod`, `kubevirt-vm`, and `docker`. Pod isolation variants such as `gvisor` and `kata` remain profiles or capabilities within the pod backend rather than separate top-level orchestration models.

Rationale:

- This keeps backend differences real without letting them leak everywhere.
- It makes lifecycle/status/reconcile logic reusable across backends.

Alternatives considered:

- Make every isolation variant a top-level backend kind. Rejected because `gvisor` and `kata` differ mainly as pod execution profiles, not as distinct orchestration object types.
- Keep a single renderer with conditionals. Rejected because it does not provide a clean inspection/reconcile boundary.

### Decision: Add an explicit runtime contract split into durable state, stale runtime artifacts, and structural invariants

Workspace runtime behavior will be defined through three categories:

- Durable state: user code, persistent agent state, persistent caches, and other data that must survive recovery.
- Stale runtime artifacts: pid files, sockets, transient runtime leftovers, and other safe-to-clean artifacts.
- Structural invariants: path layout, canonical symlinks, required directories, ownership, permission mode, and dependency/source-path sanity checks.

Rationale:

- This matches the repo's operating rule that stale runtime artifacts may be cleaned while durable state must be preserved.
- It gives reconcile logic a deterministic boundary and prevents "repair" logic from turning into implicit reset behavior.

Alternatives considered:

- Treat the full runtime home as disposable. Rejected because it breaks established persistent workspace semantics.
- Keep ad hoc runtime repair embedded in bootstrap commands. Rejected because it is hard to reason about and hard to test.

### Decision: Promote lifecycle and status to workspace semantics, not backend troubleshooting sequences

The orchestration model will define workspace lifecycle actions and workspace health/status states. Health must reflect more than liveness of a pod, VM, or container; it must represent backend reachability, daemon readiness, pairing readiness where applicable, and degrade/failure reasons.

Rationale:

- Current operational pain comes from ambiguous state: a runtime may be "running" while the workspace is functionally unavailable.
- Standardizing status gives tests and operators a stable contract.

Alternatives considered:

- Keep lifecycle implicit in `apply` and manual operational commands. Rejected because it forces operators to infer state from backend-specific tools.

### Decision: Preserve old docker runtime content as packaged legacy material during migration

The docker path enters the new TypeScript backend driver model, but existing docker-specific content is preserved under a `legacy/` boundary first rather than being refactored immediately.

Rationale:

- The user explicitly wants the old docker material retained and untouched during the control-plane migration.
- This reduces migration scope while still giving docker a place in the backend model.

Alternatives considered:

- Rewrite docker alongside pod and kubevirt in the first pass. Rejected because it expands scope and risks disturbing working legacy behavior unnecessarily.
- Omit docker from the new backend model entirely. Rejected because docker is one of the desired backend kinds in the orchestration abstraction.

### Decision: Use layered spec structure rather than a flat per-project parameter file

Saved configs stay in backend-specific directories, but the design will support a conceptual layering model:

- backend-agnostic workspace intent
- backend/profile defaults
- project-specific overrides

The change does not require inventing a new external DSL; it requires `agentctl.py` to treat spec inputs as layered workspace definitions instead of a single opaque parameter file.

Rationale:

- The repo already needs reuse across backends and project profiles.
- This enables determinism without forcing hand-maintained generated files.

Alternatives considered:

- One giant per-project file with all backend differences inline. Rejected because it scales poorly and hides which values are defaults versus overrides.

## Risks / Trade-offs

- [Migration churn from Python to TypeScript] → Mitigation: migrate through a documented shim/hand-off plan and keep saved config semantics stable while the entrypoint changes.
- [Driver abstraction that is too generic] → Mitigation: keep the first driver contract narrow: plan, realize/apply, inspect, reconcile-runtime-artifacts, and report-health.
- [Spec layering adds cognitive overhead] → Mitigation: preserve existing saved config locations and make layering explicit in documentation and validation output.
- [Operators may expect health to equal backend liveness] → Mitigation: define separate liveness, readiness, and degraded/failure states in status output.
- [Runtime contract may still miss backend-specific edge cases] → Mitigation: encode backend capability checks and backend-specific invariants in backend spec files and validation.
- [Legacy docker behavior accidentally regresses during migration] → Mitigation: keep old docker assets packaged under a legacy boundary and only wrap them with the new driver interface at first.

## Migration Plan

1. Introduce a TypeScript toolchain and a new `scripts/agentctl.ts` entrypoint without changing saved workspace intent yet.
2. Implement the normalized workspace model, config loading, and backend driver interfaces in TypeScript.
3. Reorganize config layout into `config/specs/**` and `config/generated/**`, with pod profiles under `config/specs/pod/profiles/`.
4. Preserve old docker material under a packaged legacy boundary and wrap it with the new docker driver instead of rewriting it immediately.
5. Move lifecycle, health, and reconcile behavior into TypeScript workspace actions.
6. Update docs and validation commands so TypeScript becomes the source of truth and Python is retired from the normal operator path.
7. Rollback strategy: keep the current saved workspace semantics and generated outputs recoverable while the TypeScript entrypoint stabilizes, so the old Python entrypoint can serve as an emergency fallback only during migration.

## Open Questions

- How much of the existing Python implementation should be preserved temporarily as a shim versus replaced directly?
- Should workspace status be persisted to a state file under repo control, or derived live on demand from backend inspection plus saved config?
- Which daemon-specific readiness signals belong in the generic workspace contract, and which should remain backend or profile specific?
