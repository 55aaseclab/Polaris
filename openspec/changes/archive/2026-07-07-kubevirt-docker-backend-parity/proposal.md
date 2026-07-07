## Why

Polaris now has a real runtime-controller pipeline, but only the pod backend meaningfully participates in it. `kubevirt-vm` still lacks operational lifecycle support and only shallowly inspects live state, while `docker` is still effectively treated as a legacy path instead of a true Polaris backend. That leaves the platform with one real backend and two partial ones.

## What Changes

- Promote `kubevirt-vm` to a full runtime-controller backend with:
  - live apply
  - start/stop/restart
  - richer observation fidelity
  - reconcile execution
- Promote `docker` from legacy-only behavior to a first-class Polaris backend with:
  - render/apply
  - create/start/stop/restart/rebuild
  - live observation
  - reconcile execution
- Ensure both backends participate in the same control-plane loop:
  - observation
  - drift detection
  - status synthesis
  - reconcile planning
  - backend action execution
- Keep attachment semantics consistent across `pod`, `kubevirt-vm`, and `docker`.
- Reduce backend-specific special cases that currently prevent parity of operational behavior.

## Capabilities

### New Capabilities
- `workspace-backend-parity`: Full runtime-controller parity for `kubevirt-vm` and `docker` backends.

### Modified Capabilities
- `workspace-backend-observation`: KubeVirt and Docker must return structured observations at meaningful operational fidelity.
- `workspace-runtime-controller`: Reconcile execution and status fidelity expand beyond the pod backend.
- `workspace-orchestration`: KubeVirt and Docker lifecycle actions become real workspace actions instead of placeholders or legacy escape hatches.

## Impact

- Primary impact on `scripts/polaris/backends/kubevirt/**`, `scripts/polaris/backends/docker/**`, and controller command wiring.
- Operational impact on how VM and Docker workspaces are rendered, started, stopped, inspected, and reconciled.
- Documentation impact on `docs/polaris/README.md`, `docs/polaris/runtime-layout.md`, and operations documentation.
- Test impact across backend lifecycle coverage, observation fidelity, drift/status expectations, and reconcile behavior.
