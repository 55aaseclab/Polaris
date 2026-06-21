## MODIFIED Requirements

### Requirement: Workspace orchestration SHALL expose lifecycle semantics
The system SHALL define workspace lifecycle semantics for create, start, stop, restart, rebuild, status, and reconcile operations. Those lifecycle operations MUST be defined as workspace actions even when their backend realization differs, and `status` and `reconcile` SHALL depend on control-plane observation and planning rather than on thin backend delegation alone. When agent managers support shared daemon-level prompt injection, both CLI and web-portal run entrypoints SHALL inherit the same retrieved lesson context through that shared daemon surface rather than through entrypoint-specific wrappers only.

#### Scenario: Lifecycle is expressed as workspace state transitions
- **WHEN** an operator invokes a lifecycle action for a managed project
- **THEN** the system SHALL interpret the action as a workspace lifecycle transition rather than a direct backend-manifest mutation

#### Scenario: Reconcile is distinct from rebuild
- **WHEN** the system performs a reconcile action
- **THEN** it SHALL attempt to restore declared workspace invariants without resetting durable workspace state

#### Scenario: CLI and web runs share lesson recall path
- **WHEN** a workspace uses a daemon-backed manager that supports shared prompt injection
- **THEN** both CLI-launched and web-portal-launched agent runs SHALL inherit the same retrieved lesson context through the manager daemon
