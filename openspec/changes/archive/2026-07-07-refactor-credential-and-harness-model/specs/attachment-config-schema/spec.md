## ADDED Requirements

### Requirement: Credential material references SHALL map to explicit user attachment classes

The system SHALL represent managed credential material through explicit
credential records whose files map to user-scoped attachment classes. SSH
credential material SHALL resolve through `user-ssh-state`, and harness
credential material such as Codex auth and config SHALL resolve through
`user-identity-state`.

#### Scenario: SSH credential material is user-ssh-state backed

- **WHEN** the system creates or loads a managed SSH credential
- **THEN** the credential material reference SHALL resolve to the user-scoped
  SSH attachment class

#### Scenario: Codex credential material is user-identity-state backed

- **WHEN** the system creates or loads a managed Codex credential
- **THEN** the credential material reference SHALL resolve to the user-scoped
  identity attachment class
