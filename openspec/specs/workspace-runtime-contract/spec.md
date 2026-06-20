# workspace-runtime-contract Specification

## Purpose
TBD - created by archiving change coder-inspired-workspace-orchestration. Update Purpose after archive.
## Requirements
### Requirement: Workspace runtime SHALL classify managed filesystem and process state
The system SHALL classify managed workspace runtime state into three categories: durable state, stale runtime artifacts, and structural invariants. This classification MUST govern bootstrap, recovery, and reconcile behavior.

#### Scenario: Durable state is preserved during recovery
- **WHEN** a workspace is restarted or reconciled after runtime issues
- **THEN** the system SHALL preserve durable workspace state and SHALL NOT reset it as part of automatic cleanup

#### Scenario: Stale runtime artifacts are safe cleanup targets
- **WHEN** the system detects stale runtime artifacts such as pid files, sockets, or transient leftovers
- **THEN** it SHALL allow cleanup of those artifacts without treating that cleanup as durable-state mutation

### Requirement: Workspace runtime SHALL enforce structural invariants deterministically
The system SHALL enforce required structural invariants for a managed workspace, including canonical path layout, required directories, ownership rules, permission modes, and dependency/source-path sanity checks. Structural invariant enforcement MUST be deterministic and MUST avoid destructive mutation of durable state.

#### Scenario: Required runtime structure is restored safely
- **WHEN** a managed workspace is missing a required directory or has a non-canonical runtime link that is classified as a structural invariant issue
- **THEN** the system SHALL restore the required structure without deleting durable user state

#### Scenario: Ownership and mode violations are treated as invariant failures
- **WHEN** required ownership or permission modes for managed runtime paths do not match the declared runtime contract
- **THEN** the system SHALL report and reconcile the mismatch as a structural invariant failure

### Requirement: Workspace health SHALL report functional readiness, not only backend liveness
The system SHALL report workspace health in terms of functional readiness, including backend reachability, runtime readiness, daemon readiness where applicable, and degraded or failed reasons. Backend liveness alone MUST NOT be treated as sufficient workspace health.

#### Scenario: Runtime is alive but workspace is degraded
- **WHEN** the backing pod, VM, or container is running but daemon readiness or runtime access checks fail
- **THEN** the system SHALL report the workspace as degraded or unavailable with the relevant failure reason

#### Scenario: Status distinguishes liveness from readiness
- **WHEN** an operator requests workspace status
- **THEN** the system SHALL distinguish backend liveness from workspace readiness in the reported status

### Requirement: Runtime reconciliation SHALL be explicit and auditable
The system SHALL treat runtime cleanup and repair as explicit reconcile behavior and SHALL surface what class of issue was detected and what class of action was taken.

#### Scenario: Reconcile reports cleanup scope
- **WHEN** reconcile removes stale runtime artifacts or restores structural invariants
- **THEN** the system SHALL report whether it cleaned stale artifacts, restored structural invariants, or refused an action because it would affect durable state

#### Scenario: Unsafe repair is rejected
- **WHEN** a proposed automatic repair would require mutating data classified as durable state
- **THEN** the system SHALL reject that repair as an automatic reconcile action

