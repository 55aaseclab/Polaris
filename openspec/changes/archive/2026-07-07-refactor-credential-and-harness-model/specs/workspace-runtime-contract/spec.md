## ADDED Requirements

### Requirement: Runtime assembly SHALL mount active user harness credentials into standard paths

The system SHALL assemble active user harness credentials into the standard
runtime-visible paths for each supported harness. Harness credential material
selection SHALL be independent from whether the harness CLI is installed.

#### Scenario: Active Codex credential is assembled

- **WHEN** a workspace runtime is assembled for a user with an active Codex
  credential
- **THEN** the system SHALL mount that credential's auth and config material
  into the standard Codex runtime paths

#### Scenario: No active Codex credential is selected

- **WHEN** a workspace runtime is assembled for a user without an active Codex
  credential
- **THEN** the system SHALL omit Codex credential material from the assembled
  runtime
- **AND** the system SHALL NOT treat that omission as removing Codex tooling

### Requirement: Harness tooling SHALL come from a shared tool catalog

The system SHALL provision workspace harness tooling from a shared catalog so
that supported harnesses are declared consistently across workspace backends.

#### Scenario: Shared harness catalog is used during bootstrap

- **WHEN** workspace tooling is bootstrapped for a backend
- **THEN** the backend bootstrap flow SHALL use the shared harness catalog to
  determine which CLIs to provision

#### Scenario: First-phase harness catalog

- **WHEN** the first phase of this change is applied
- **THEN** the shared harness catalog SHALL include `codex`, `claude`,
  `copilot`, `opencode`, and `pi`
