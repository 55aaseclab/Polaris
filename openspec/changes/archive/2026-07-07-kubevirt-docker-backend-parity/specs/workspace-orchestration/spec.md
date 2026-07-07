## MODIFIED Requirements

### Requirement: Workspace orchestration SHALL use backend drivers
The system SHALL realize managed workspaces through backend drivers that implement a common orchestration boundary for planning, realization, inspection, health reporting, and runtime-controller participation. Backend-specific rules MUST remain behind the appropriate backend driver or backend-specific spec input, and `kubevirt-vm` and `docker` SHALL not remain second-class lifecycle paths.

#### Scenario: Pod and VM paths share one orchestration model
- **WHEN** a workspace is configured for `backend.kind=pod` or `backend.kind=kubevirt-vm`
- **THEN** both paths SHALL be planned through the same workspace orchestration model and diverge only at backend driver realization

#### Scenario: Docker participates as a real backend
- **WHEN** a workspace is configured for `backend.kind=docker`
- **THEN** it SHALL participate in the same orchestration and controller model as other backends rather than existing only as a side-path or legacy escape hatch
