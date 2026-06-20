## MODIFIED Requirements

### Requirement: Workspace runtime SHALL classify managed filesystem and process state
The system SHALL classify managed workspace runtime state into two categories: minimal runtime invariants and stale runtime artifacts. Durable persistence semantics MUST be defined through attachment classes rather than through the runtime contract, and these runtime concerns SHALL feed into drift detection and reconcile planning rather than only static validation.

#### Scenario: Durable attachments are not defined by runtime-path persistence
- **WHEN** the control plane defines durable state semantics
- **THEN** it SHALL define them through attachment classes rather than by declaring a runtime home or flat durable path list

#### Scenario: Stale runtime artifacts are safe cleanup targets
- **WHEN** the system detects stale runtime artifacts such as pid files, sockets, or transient leftovers
- **THEN** it SHALL allow cleanup of those artifacts without treating that cleanup as durable-state mutation
