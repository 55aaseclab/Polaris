## MODIFIED Requirements

### Requirement: Workspace runtime SHALL classify managed filesystem and process state
The system SHALL classify managed workspace runtime state into two categories: minimal runtime invariants and stale runtime artifacts. Durable persistence semantics MUST be defined through attachment classes rather than through the runtime contract.

#### Scenario: Durable attachments are not defined by runtime-path persistence
- **WHEN** the control plane defines durable state semantics
- **THEN** it SHALL define them through attachment classes rather than by declaring a runtime home or flat durable path list

#### Scenario: Stale runtime artifacts are safe cleanup targets
- **WHEN** the system detects stale runtime artifacts such as pid files, sockets, or transient leftovers
- **THEN** it SHALL allow cleanup of those artifacts without treating that cleanup as durable-state mutation

### Requirement: Workspace runtime SHALL enforce structural invariants deterministically
The system SHALL enforce required structural invariants for a managed workspace, including canonical runtime path assembly, required directories, ownership rules, permission modes, and dependency/source-path sanity checks. Structural invariant enforcement MUST be deterministic and MUST avoid destructive mutation of durable attachments.

#### Scenario: Required runtime structure is restored safely
- **WHEN** a managed workspace is missing a required directory or has a non-canonical runtime link that is classified as a structural invariant issue
- **THEN** the system SHALL restore the required structure without deleting durable user or workspace attachments

#### Scenario: Ownership and mode violations are treated as invariant failures
- **WHEN** required ownership or permission modes for managed runtime paths do not match the declared runtime contract
- **THEN** the system SHALL report and reconcile the mismatch as a structural invariant failure
