## MODIFIED Requirements

### Requirement: Workspace runtime SHALL classify managed filesystem and process state

The system SHALL classify managed workspace runtime state into two categories:
minimal runtime invariants and stale runtime artifacts.
Durable persistence semantics MUST be defined through attachment classes rather
than through the runtime contract, and these runtime concerns SHALL feed into
drift detection and reconcile planning rather than only static validation.
For daemon-backed memory-aware runtimes, the runtime state SHALL also include:

- memory-supporting artifacts
- pending memory-write state
- session memory snapshot state
- optional provider sync state

#### Scenario: Durable attachments are not defined by runtime-path persistence

- **WHEN** the control plane defines durable state semantics
- **THEN** it SHALL define them through attachment classes rather than by
  declaring a runtime home or flat durable path list

#### Scenario: Stale runtime artifacts are safe cleanup targets

- **WHEN** the system detects stale runtime artifacts such as pid files,
  sockets, or transient leftovers
- **THEN** it SHALL allow cleanup of those artifacts without treating that
  cleanup as durable-state mutation

#### Scenario: Runtime memory state is part of managed contract

- **WHEN** a workspace enables daemon-backed memory capture
- **THEN** the runtime contract SHALL include execution-event capture,
  memory-supporting artifacts, and session memory snapshot state under managed
  runtime evolution state

#### Scenario: Session memory snapshot path is under managed evolution state

- **WHEN** Polaris prepares a session snapshot for a daemon-backed runtime
- **THEN** the runtime snapshot SHALL be written under
  `<evolutionRoot>/sessions/<session-id>/memory-snapshot.md`
