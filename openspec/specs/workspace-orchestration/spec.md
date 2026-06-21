# workspace-orchestration Specification

## Purpose
TBD - created by archiving change coder-inspired-workspace-orchestration. Update Purpose after archive.
## Requirements
### Requirement: Workspace SHALL be a first-class orchestration object
The system SHALL treat each managed environment as a workspace object with explicit identity, backend selection, attachment-based storage policy, runtime configuration, connectivity settings, lifecycle policy, and health policy. Saved backend specs and generated manifests MUST be derived representations of that workspace object rather than the primary orchestration model, and the saved workspace intent SHALL declare attachment-based storage directly rather than primarily through legacy path-centric persistence fields.

#### Scenario: Workspace intent is normalized before backend rendering
- **WHEN** the TypeScript `agentctl` control plane loads a project configuration
- **THEN** it SHALL normalize the project into a workspace model before generating backend-specific output

#### Scenario: Generated output remains backend-specific
- **WHEN** the normalized workspace is rendered for a target backend
- **THEN** the generated manifest SHALL remain an output artifact and SHALL NOT become the source of truth for workspace behavior

### Requirement: Workspace orchestration SHALL use backend drivers
The system SHALL realize managed workspaces through backend drivers that implement a common orchestration boundary for planning, realization, inspection, and health reporting. Backend-specific rules MUST remain behind the appropriate backend driver or backend-specific spec input.

#### Scenario: Pod and VM paths share one orchestration model
- **WHEN** a workspace is configured for `backend.kind=pod` or `backend.kind=kubevirt-vm`
- **THEN** both paths SHALL be planned through the same workspace orchestration model and diverge only at backend driver realization

#### Scenario: Pod profiles remain inside the pod backend
- **WHEN** a workspace uses `gvisor` or `kata`
- **THEN** the system SHALL model those as pod profiles rather than top-level backend kinds

#### Scenario: Backend-specific validation stays local
- **WHEN** a backend requires backend-specific constraints or inputs
- **THEN** the system SHALL enforce those constraints through backend-specific validation rather than global operator notes

### Requirement: Workspace orchestration SHALL expose lifecycle semantics
The system SHALL define workspace lifecycle semantics for create, start, stop, restart, rebuild, status, and reconcile operations. Those lifecycle operations MUST be defined as workspace actions even when their backend realization differs, and `status` and `reconcile` SHALL depend on control-plane observation and planning rather than on thin backend delegation alone.

#### Scenario: Lifecycle is expressed as workspace state transitions
- **WHEN** an operator invokes a lifecycle action for a managed project
- **THEN** the system SHALL interpret the action as a workspace lifecycle transition rather than a direct backend-manifest mutation

#### Scenario: Reconcile is distinct from rebuild
- **WHEN** the system performs a reconcile action
- **THEN** it SHALL attempt to restore declared workspace invariants without resetting durable workspace state

### Requirement: Workspace orchestration SHALL validate backend capabilities before realization
The system SHALL validate that requested workspace features are compatible with the selected backend and backend profile before it attempts live realization or apply.

#### Scenario: Unsupported backend capability is rejected early
- **WHEN** a workspace requests a capability that the selected backend cannot satisfy
- **THEN** the system SHALL fail validation before live apply and SHALL report the incompatible capability and backend context

#### Scenario: Pod profiles are evaluated within the pod backend
- **WHEN** a workspace uses a pod backend profile such as `gvisor` or `kata`
- **THEN** the system SHALL validate profile-specific capabilities within the pod backend model rather than treating the profile as a different top-level workspace type

### Requirement: TypeScript SHALL be the orchestration source of truth
The system SHALL use the TypeScript `agentctl` CLI as the unified orchestration entrypoint. Python MUST NOT remain the long-term source of truth for workspace orchestration after the migration completes.

#### Scenario: Operators use the TypeScript entrypoint
- **WHEN** an operator renders, applies, inspects, or reconciles a workspace
- **THEN** the action SHALL be routed through the TypeScript `agentctl` CLI

#### Scenario: Python is reduced to migration-only behavior
- **WHEN** the TypeScript migration is complete
- **THEN** any remaining Python entrypoint behavior SHALL be limited to migration compatibility or be removed from the normal operator path

