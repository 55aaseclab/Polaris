## 1. KubeVirt Parity

- [x] 1.1 Implement real KubeVirt lifecycle actions for apply, start, stop, restart, and rebuild
- [x] 1.2 Improve KubeVirt inspection beyond object existence to include VM/VMI state and meaningful service observation
- [x] 1.3 Extend KubeVirt backend execution so it can carry out safe reconcile-plan actions
- [x] 1.4 Ensure KubeVirt status and reconcile output flows through the shared runtime-controller model

## 2. Docker Promotion

- [x] 2.1 Promote Docker from legacy-only behavior to a real Polaris backend interface
- [x] 2.2 Implement Docker render/apply/create/start/stop/restart/rebuild behavior using the attachment model
- [x] 2.3 Implement structured Docker observations for container state, attachment presence, runtime assembly, and service exposure
- [x] 2.4 Implement Docker reconcile execution for the safe actions Polaris supports

## 3. Controller And Backend Parity

- [x] 3.1 Ensure KubeVirt and Docker observations participate in shared drift computation and status synthesis
- [x] 3.2 Ensure KubeVirt and Docker expose unsupported or unrecoverable drift explicitly rather than through generic placeholders
- [x] 3.3 Keep attachment semantics consistent across pod, kubevirt-vm, and docker even where physical realization differs
- [x] 3.4 Remove or reduce backend-specific special cases that block first-class parity

## 4. Docs And Verification

- [x] 4.1 Update Polaris docs to describe KubeVirt and Docker as first-class runtime-controller backends
- [x] 4.2 Add or update tests for KubeVirt and Docker observation fidelity and lifecycle execution
- [x] 4.3 Add or update tests for backend-specific reconcile-plan execution and unsupported-drift reporting
- [x] 4.4 Validate parity through TypeScript typecheck, test suite, and representative backend-specific status/reconcile flows
