## Context

Polaris now has a direct attachment config model and a working runtime-controller pipeline, but only the pod backend meaningfully participates in that pipeline. KubeVirt and Docker are still asymmetric:

- `kubevirt-vm` can render and partially inspect, but lifecycle actions and reconcile execution are mostly unimplemented.
- `docker` is still treated as a legacy or transitional path rather than a true Polaris backend.

This makes Polaris architecturally cleaner than before, but operationally uneven: there is one real backend (`pod`) and two partial ones.

## Goals / Non-Goals

**Goals:**

- Promote `kubevirt-vm` and `docker` to first-class runtime-controller backends.
- Make all three major backends (`pod`, `kubevirt-vm`, `docker`) participate in:
  - live observation
  - drift detection
  - status synthesis
  - reconcile planning
  - backend action execution
- Keep attachment semantics consistent across all backends even when physical realization differs.
- Replace placeholder or unsupported backend behavior with explicit supported lifecycle and inspection behavior.

**Non-Goals:**

- Making all three backends equal in implementation depth on day one.
- Redesigning the runtime-controller model itself.
- Changing the attachment taxonomy again.
- Building a built-in agent harness or changing the Polaris/Paseo/Codex/Claude separation.

## Decisions

### Decision: KubeVirt is treated as a true Polaris backend, not a spec-only backend

KubeVirt should support real controller lifecycle operations and not remain restricted to render-only or object-existence-level behavior.

Rationale:

- It is already modeled as a backend kind in Polaris.
- Keeping it half-real undermines the workspace-platform story.

Alternatives considered:

- Leave KubeVirt as render-only for longer. Rejected because it preserves an artificial gap inside the backend model.

### Decision: Docker is promoted from legacy path to first-class backend

Docker will be treated as a real backend rather than an operations-side escape hatch.

Rationale:

- The user explicitly wants Docker as a first-class Polaris backend.
- The runtime-controller pipeline should apply consistently across named backends.

Alternatives considered:

- Keep Docker as a convenience operational path only. Rejected because it would preserve a mixed backend model and make the platform contract ambiguous.

### Decision: Backend parity means controller parity, not identical implementation

Parity means each backend participates in the same control-plane model and exposes the same categories of lifecycle and observation behavior. It does not mean every backend must use the same low-level implementation or reach the same runtime fidelity immediately.

Rationale:

- This preserves a clean platform contract without overfitting backends to one implementation style.
- It allows phased backend improvement while keeping semantics aligned.

Alternatives considered:

- Require identical depth and implementation style across all backends before calling them first-class. Rejected because that would delay real progress unnecessarily.

### Decision: KubeVirt and Docker must support observation, not just execution

Both backends must return structured `BackendObservation` rather than only supporting render/apply/start operations.

Rationale:

- Without observation, the runtime-controller pipeline becomes pod-only in practice.
- Status and reconcile must be grounded in evidence, not assumptions.

Alternatives considered:

- Add lifecycle execution first and improve observation later. Rejected because it would recreate blind backend actions in the new controller model.

### Decision: Unsupported backend drift remains explicit until each backend grows full action coverage

If KubeVirt or Docker cannot yet repair certain drift safely, the controller should represent that explicitly through drift and reconcile-plan outcomes rather than hiding it behind generic unsupported placeholders.

Rationale:

- Operators need truthful status even when action coverage is incomplete.
- This supports incremental backend maturity without misrepresenting backend health.

Alternatives considered:

- Keep broad “unsupported” responses for the whole backend. Rejected because it is too coarse and blocks useful controller feedback.

## Risks / Trade-offs

- [Docker parity may expose deeper mismatches between Compose-era assumptions and Polaris attachments] → Mitigation: keep the attachment contract authoritative and adapt Docker realization to it incrementally.
- [KubeVirt observation fidelity may lag pod observation fidelity] → Mitigation: keep observation structured and truthful even when partial, and grow depth incrementally.
- [Controller logic may become backend-branchy again] → Mitigation: keep backend-specific work inside observation and execution, while shared drift/status/plan logic remains centralized.
- [First-class Docker may complicate current operational scripts] → Mitigation: progressively absorb Docker behavior into the backend while keeping operations scripts as thin wrappers or compatibility helpers.
- [Backend parity work may touch many files at once] → Mitigation: sequence implementation by backend and preserve tests for each parity milestone.

## Migration Plan

1. Expand KubeVirt observation and lifecycle support first.
2. Promote Docker from legacy behavior to a first-class backend interface with attachment-aware lifecycle and observation.
3. Extend backend execution hooks so KubeVirt and Docker can carry out reconcile-plan actions.
4. Update docs and status semantics to reflect that all named backends participate in the controller pipeline.
5. Deepen fidelity over time while keeping the controller contract stable.

## Open Questions

- What should the first “good enough” Docker observation model include beyond container existence and mount state?
- Should Docker use Compose directly as its execution primitive, or should Polaris begin generating/running container definitions more directly?
- How much guest-side runtime truth can KubeVirt realistically inspect without adding a deeper guest agent or explicit in-guest probe path?
- Which reconcile actions should be considered safe and immediately supported for KubeVirt and Docker first?
