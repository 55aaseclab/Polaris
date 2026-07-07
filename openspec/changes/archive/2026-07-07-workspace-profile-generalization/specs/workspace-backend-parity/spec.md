## MODIFIED Requirements

### Requirement: KubeVirt and Docker SHALL be first-class runtime-controller backends
The system SHALL treat `kubevirt-vm` and `docker` as first-class runtime-controller backends rather than as spec-only or legacy escape-hatch paths, and their implementations SHALL consume reusable workspace profile inputs rather than Morpheus-specific backend assumptions.

#### Scenario: KubeVirt participates in the runtime-controller loop
- **WHEN** a workspace uses `backend.kind=kubevirt-vm`
- **THEN** the backend SHALL participate in observation, status synthesis, reconcile planning, and backend action execution

#### Scenario: Docker participates in the runtime-controller loop
- **WHEN** a workspace uses `backend.kind=docker`
- **THEN** the backend SHALL participate in observation, status synthesis, reconcile planning, and backend action execution
