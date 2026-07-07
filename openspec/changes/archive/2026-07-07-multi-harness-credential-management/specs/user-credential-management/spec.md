## ADDED Requirements

### Requirement: The system SHALL manage user credentials by harness family

The system SHALL expose user-scoped credentials grouped by harness family so
operators can manage SSH, Codex, Claude, Copilot, OpenCode, and pi credentials
as distinct inventories rather than as a single flat Codex-only list.

#### Scenario: Portal groups credentials by harness family

- **WHEN** an operator opens the credentials page for a user
- **THEN** the system SHALL render separate sections for each supported harness
  family with only that family's credentials in each section

#### Scenario: CLI lists harness-aware credentials

- **WHEN** an operator lists credentials for a user through the Polaris CLI
- **THEN** the system SHALL return each credential with harness-aware metadata
  that identifies which harness family it belongs to

### Requirement: The system SHALL create harness credentials from reusable templates

The system SHALL allow operators to create harness credentials from reusable
templates, with Codex credentials seeded from a maintained preset/template
catalog and SSH credentials seeded from the user profile's SSH policy.

#### Scenario: Portal creates a Codex credential from template-backed fields

- **WHEN** an operator uses the credentials page to add a Codex credential
- **THEN** the system SHALL persist a user-scoped credential record and
  generated Codex material files derived from the selected template and form
  values

#### Scenario: CLI creates an SSH credential from managed-key policy

- **WHEN** an operator creates an SSH credential for a managed-key user profile
- **THEN** the system SHALL generate the SSH keypair material and persist the
  corresponding credential record for that user

### Requirement: The system SHALL allow row-level credential deletion

The system SHALL allow an operator to delete an individual credential from its
own harness section without affecting unrelated credentials for the same user.

#### Scenario: Portal deletes one Codex credential

- **WHEN** an operator deletes one Codex credential row from the credentials page
- **THEN** the system SHALL remove that credential's registry document and
  generated material files while leaving other credentials unchanged

#### Scenario: CLI deletes one credential by id

- **WHEN** an operator deletes a credential by user id and credential id through
  the Polaris CLI
- **THEN** the system SHALL remove only that credential's persisted record and
  material files
