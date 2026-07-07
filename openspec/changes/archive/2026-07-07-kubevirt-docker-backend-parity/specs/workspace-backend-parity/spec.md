## ADDED Requirements

### Requirement: KubeVirt and Docker SHALL be first-class runtime-controller backends
The system SHALL treat `kubevirt-vm` and `docker` as first-class runtime-controller backends rather than as spec-only or legacy escape-hatch paths.

#### Scenario: KubeVirt participates in the runtime-controller loop
- **WHEN** a workspace uses `backend.kind=kubevirt-vm`
- **THEN** the backend SHALL participate in observation, status synthesis, reconcile planning, and backend action execution

#### Scenario: Docker participates in the runtime-controller loop
- **WHEN** a workspace uses `backend.kind=docker`
- **THEN** the backend SHALL participate in observation, status synthesis, reconcile planning, and backend action execution

### Requirement: First-class parity SHALL preserve attachment semantics
All first-class backends SHALL realize the same attachment semantics even when their physical implementation differs.

#### Scenario: Backend implementation differences do not change attachment meaning
- **WHEN** the same logical attachment class is realized on `pod`, `kubevirt-vm`, and `docker`
- **THEN** its scope, sharing, and lifecycle meaning SHALL remain consistent across those backends
