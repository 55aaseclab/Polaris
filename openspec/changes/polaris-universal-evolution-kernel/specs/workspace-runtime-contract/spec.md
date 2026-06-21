## MODIFIED Requirements

### Requirement: Workspace runtime SHALL classify managed filesystem and process state
The system SHALL classify managed workspace runtime state into attachment-scoped durable state, minimal runtime invariants, stale runtime artifacts, and manager/evolution runtime tenants. Durable persistence semantics MUST be defined through attachment classes rather than through the runtime contract, and these runtime concerns SHALL feed into drift detection and reconcile planning rather than only static validation.

#### Scenario: Durable attachments are not defined by runtime-path persistence
- **WHEN** the control plane defines durable state semantics
- **THEN** it SHALL define them through attachment classes rather than by declaring a runtime home or flat durable path list

#### Scenario: Stale runtime artifacts are safe cleanup targets
- **WHEN** the system detects stale runtime artifacts such as pid files, sockets, or transient leftovers
- **THEN** it SHALL allow cleanup of those artifacts without treating that cleanup as durable-state mutation

#### Scenario: Workspace runtime state can host manager-generic evolution data
- **WHEN** a workspace enables a manager-backed evolution kernel
- **THEN** the durable workspace runtime state SHALL be able to host evolution state without requiring that the durable manager state be named or shaped as Paseo-specific state

## MODIFIED Requirements

### Requirement: Workspace health SHALL report functional readiness, not only backend liveness
The system SHALL report workspace health in terms of functional readiness, including backend reachability, runtime readiness, manager readiness where applicable, and degraded or failed reasons. Backend liveness alone MUST NOT be treated as sufficient workspace health.

#### Scenario: Runtime is alive but workspace is degraded
- **WHEN** the backing pod, VM, or container is running but manager readiness or runtime access checks fail
- **THEN** the system SHALL report the workspace as degraded or unavailable with the relevant failure reason

#### Scenario: Status distinguishes liveness from readiness
- **WHEN** an operator requests workspace status
- **THEN** the system SHALL distinguish backend liveness from workspace readiness in the reported status

#### Scenario: Readiness is not tied to a specific manager name
- **WHEN** the workspace runtime validates durable manager state or daemon surfaces
- **THEN** it SHALL evaluate the configured manager contract rather than assuming that readiness is equivalent to the presence of a Paseo-specific path or process
