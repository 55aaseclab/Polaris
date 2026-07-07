# user-credential-management Specification

## Purpose
TBD - created by archiving change multi-harness-credential-management. Update Purpose after archive.
## Requirements
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

### Requirement: User credential provisioning SHALL be driven by the user profile

The system SHALL provision required user credentials from the user profile
through a shared credential management path. `user create` SHALL request only
the credentials required by the user profile and SHALL NOT create provider-
specific Codex credentials implicitly.

#### Scenario: Creating a user with an SSH-required profile

- **WHEN** an operator or portal flow creates a user whose profile requires SSH
  credential support
- **THEN** the system SHALL create the SSH credential record through the
  credential management path
- **AND** the system SHALL generate SSH key material through that same path
- **AND** the system SHALL NOT create a Codex provider credential implicitly

#### Scenario: Deleting a user removes managed credentials through one path

- **WHEN** an operator or portal flow deletes a user
- **THEN** the system SHALL delete that user's managed credential records
  through the credential management path
- **AND** the system SHALL remove associated managed material files

### Requirement: User credential management SHALL support explicit lifecycle operations

The system SHALL support add, delete, and list operations for user-owned
credentials through a shared credential management model that is callable from
CLI and portal flows.

#### Scenario: Adding a RightCode Codex credential

- **WHEN** a user adds a Codex credential using the RightCode template
- **THEN** the system SHALL create a new user-owned credential record
- **AND** the system SHALL materialize the Codex auth and config files for that
  credential

#### Scenario: Deleting a user credential

- **WHEN** a user deletes an existing managed credential
- **THEN** the system SHALL remove the credential registry record
- **AND** the system SHALL remove managed material files associated with that
  credential

### Requirement: The system SHALL support active harness credentials at user scope

The system SHALL allow a user to mark one credential as active for a harness
provider slot such as Codex. Runtime assembly SHALL use that active credential
as the default harness credential source.

#### Scenario: Activating a different Codex credential

- **WHEN** a user switches the active Codex credential from one credential to
  another
- **THEN** the system SHALL update the active user-level Codex credential
  selection
- **AND** the system SHALL NOT treat that switch as enabling or disabling Paseo
  daemon infrastructure

#### Scenario: No active Codex credential exists

- **WHEN** a user has no active Codex credential
- **THEN** the system SHALL keep Codex tooling available
- **AND** the system SHALL report that no active Codex credential is selected

