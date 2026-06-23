## ADDED Requirements

### Requirement: User-owned credentials SHALL preserve user-scoped lifecycle
semantics

User-owned credentials that resolve through user-scoped attachment classes
SHALL remain reusable across multiple workspaces without becoming
workspace-scoped state. Binding a credential into a workspace SHALL NOT change
the lifecycle scope of its underlying material.

#### Scenario: Reused credential survives workspace deletion

- **WHEN** a workspace that binds a user-owned SSH or Codex credential is
  deleted
- **THEN** the underlying user-scoped material SHALL remain available to other
  workspaces owned by the same user

### Requirement: Credential bindings SHALL be validated against lifecycle scope

The system SHALL validate that a workspace binds only credentials whose owner,
scope, and material references are compatible with the workspace lifecycle
contract.

#### Scenario: Invalid cross-owner binding is rejected

- **WHEN** a workspace attempts to bind a credential owned by a different user
- **THEN** the system SHALL reject the binding before realization
