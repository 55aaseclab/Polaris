## ADDED Requirements

### Requirement: Credential material SHALL map onto existing attachment classes

The system SHALL project credential material onto the existing durable
attachment classes rather than introducing a parallel persistence model for
secrets. Credential kinds such as `ssh-key` and `codex-auth` SHALL resolve
through the attachment classes that already own their lifecycle semantics.

#### Scenario: SSH credential uses user SSH state

- **WHEN** a workspace binds a credential of kind `ssh-key`
- **THEN** the system SHALL resolve its material through `user-ssh-state`

#### Scenario: Codex credential uses user identity state

- **WHEN** a workspace binds a credential of kind `codex-auth`
- **THEN** the system SHALL resolve its material through `user-identity-state`
