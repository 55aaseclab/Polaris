## ADDED Requirements

### Requirement: Workspace orchestration SHALL keep infrastructure independent from credential selection

The system SHALL treat Paseo daemon lifecycle and harness tool availability as
workspace infrastructure concerns. Credential selection SHALL NOT be the
mechanism that enables or disables daemon startup or harness installation.

#### Scenario: Starting a workspace without a Codex credential

- **WHEN** a workspace starts and the user has no active Codex credential
- **THEN** the workspace SHALL still provision its declared daemon and harness
  infrastructure
- **AND** the absence of a Codex credential SHALL be reported as credential
  state rather than infrastructure disablement

#### Scenario: Switching an active Codex credential

- **WHEN** a user changes the active Codex credential
- **THEN** the system SHALL treat the change as credential selection state
- **AND** the system SHALL NOT model that change as turning workspace
  infrastructure on or off

### Requirement: Workspace scaffold SHALL NOT create provider credentials implicitly

The system SHALL NOT create provider-specific harness credentials as a side
effect of workspace scaffolding.

#### Scenario: Creating a new workspace for a user without Codex credentials

- **WHEN** the system scaffolds a new workspace for a user who has no Codex
  credentials
- **THEN** the workspace scaffold SHALL complete without creating a default
  Codex credential implicitly
