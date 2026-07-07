## ADDED Requirements

### Requirement: Runtime status SHALL report credential state separately from infrastructure state

The system SHALL report daemon readiness, harness availability, and credential
selection state as separate concerns. Runtime status SHALL NOT describe missing
or changed credentials as agent infrastructure enable or disable state.

#### Scenario: Workspace has no active Codex credential

- **WHEN** status is synthesized for a workspace whose infrastructure is ready
  but no active Codex credential is selected
- **THEN** the reported status SHALL keep daemon and harness readiness separate
  from credential selection state

#### Scenario: Credential switch does not rewrite infrastructure status

- **WHEN** a user switches the active Codex credential
- **THEN** the reported runtime status SHALL update credential selection state
- **AND** it SHALL NOT report the workspace as becoming agent-enabled or
  agent-disabled solely because of that switch
