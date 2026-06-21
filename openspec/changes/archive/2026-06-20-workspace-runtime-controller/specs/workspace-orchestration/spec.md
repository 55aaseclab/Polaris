## MODIFIED Requirements

### Requirement: Workspace orchestration SHALL expose lifecycle semantics
The system SHALL define workspace lifecycle semantics for create, start, stop, restart, rebuild, status, and reconcile operations. Those lifecycle operations MUST be defined as workspace actions even when their backend realization differs, and `status` and `reconcile` SHALL depend on control-plane observation and planning rather than on thin backend delegation alone.

#### Scenario: Lifecycle is expressed as workspace state transitions
- **WHEN** an operator invokes a lifecycle action for a managed project
- **THEN** the system SHALL interpret the action as a workspace lifecycle transition rather than a direct backend-manifest mutation

#### Scenario: Reconcile is distinct from rebuild
- **WHEN** the system performs a reconcile action
- **THEN** it SHALL attempt to restore declared workspace invariants without resetting durable workspace state
