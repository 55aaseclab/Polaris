## ADDED Requirements

### Requirement: User credentials SHALL be first-class config entities

The system SHALL model each reusable authentication object as a first-class
`Credential` entity owned by a user. A credential SHALL be declared separately
from `UserProfile` and separately from workspace config.

#### Scenario: User owns multiple credentials

- **WHEN** a user declares multiple credentials for different providers or
  purposes
- **THEN** the system SHALL load them as separate named entities under the same
  user owner

### Requirement: Credential registry entries SHALL declare stable metadata and
material references

Each credential registry entry SHALL declare at least `id`, `userId`, `kind`,
`label`, `purposes`, `materialRef`, and `status`. The registry SHALL treat
those fields as the canonical declaration surface for credential metadata and
material lookup.

#### Scenario: Registry entry is parsed deterministically

- **WHEN** the control plane loads a credential registry file
- **THEN** it SHALL parse the credential into the canonical metadata fields and
  SHALL reject entries that omit required fields

### Requirement: Credential registry SHALL keep secret material outside the
registry document

The system SHALL keep secret material outside the credential registry metadata.
Credential declarations SHALL reference material through `materialRef` rather
than embedding the secret content inline.

#### Scenario: Secret content is external to registry metadata

- **WHEN** a credential declares SSH, Codex, or token-based authentication
  material
- **THEN** the registry file SHALL reference that material and SHALL NOT
  contain the secret value inline

### Requirement: The system SHALL support credential kinds for SSH, Codex, and
token-based auth

The system SHALL support credential kinds sufficient for current workspace
authentication use cases, including `ssh-key`, `api-key`, `codex-auth`,
`git-https-token`, `kubeconfig`, and `cloud-token`.

#### Scenario: Codex auth is represented as a credential

- **WHEN** a user registers reusable Codex authentication material
- **THEN** the system SHALL model it as a `codex-auth` credential rather than
  as an implicit profile-only field

### Requirement: Workspaces SHALL bind credentials by purpose

Each workspace SHALL be able to reference one or more user-owned credentials
through explicit bindings keyed by purpose. Binding purposes SHALL be separate
from workspace driver selection.

#### Scenario: Workspace binds multiple credentials

- **WHEN** a workspace declares both `agent-auth` and `git-auth` bindings
- **THEN** the system SHALL resolve each purpose to its referenced credential
  independently of the selected workspace driver
