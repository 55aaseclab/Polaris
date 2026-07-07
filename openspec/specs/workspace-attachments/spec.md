# workspace-attachments Specification

## Purpose
TBD - created by archiving change workspace-attachments-persistence-model. Update Purpose after archive.
## Requirements
### Requirement: Persistence SHALL be modeled as attachment classes
The system SHALL model durable workspace persistence through explicit
attachment classes and SHALL expose those attachment classes directly in the
saved workspace config model rather than only as an internal representation
derived from legacy fields.

#### Scenario: Workspace intent is expressed as durable attachments
- **WHEN** the control plane models workspace persistence
- **THEN** it SHALL express persistence in terms of attachment classes with
  defined scope, sharing, and durability semantics

#### Scenario: Runtime paths are assembled from attachments
- **WHEN** runtime paths such as home-local config or SSH locations are exposed
  inside a workspace
- **THEN** those paths SHALL be treated as assembled views of attachments
  rather than the persistence contract itself

### Requirement: The system SHALL distinguish workspace-scoped and user-scoped durable attachments
The system SHALL distinguish workspace-scoped durable attachments from
user-scoped durable attachments, and user-scoped durable attachments SHALL be
owned by an explicit user profile rather than only by implicit runtime-user
conventions.

#### Scenario: Workspace deletion preserves user-scoped attachments
- **WHEN** a workspace is deleted
- **THEN** user-scoped durable attachments SHALL remain intact

#### Scenario: Workspace restart preserves workspace-scoped durable attachments
- **WHEN** a workspace is restarted or rebuilt
- **THEN** workspace-scoped durable attachments SHALL remain attached to that
  workspace unless explicitly removed by workspace lifecycle policy

### Requirement: The system SHALL support four durable attachment classes
The system SHALL support four durable attachment classes: `workspace-data`,
`workspace-runtime-state`, `user-identity-state`, and `user-ssh-state`.

#### Scenario: `codex` and `claude` map to user identity state
- **WHEN** the control plane classifies durable state for `codex` and `claude`
- **THEN** it SHALL classify that state as `user-identity-state`

#### Scenario: SSH material maps to user SSH state
- **WHEN** the control plane classifies SSH private data, known hosts, or SSH
  configuration
- **THEN** it SHALL classify that state as `user-ssh-state`

#### Scenario: `paseo` maps to workspace runtime state
- **WHEN** the control plane classifies durable `paseo` state
- **THEN** it SHALL classify that state as `workspace-runtime-state`

#### Scenario: Project data maps to workspace data
- **WHEN** the control plane classifies project/worktree data and
  workspace-local outputs
- **THEN** it SHALL classify that state as `workspace-data`

### Requirement: Workspace data SHALL support a backend-stable shared source

The system SHALL allow `workspace-data` to be realized from a shared source
that remains stable across backend changes. When `workspace-data` uses a shared
source, the workspace spec SHALL remain the single source of truth for that
project store instead of deriving separate backend-local copies.

#### Scenario: Project data remains one logical attachment across drivers

- **WHEN** the same workspace is rendered for Docker and pod-oriented backends
- **THEN** `workspace-data` SHALL refer to one logical shared project store
  rather than separate backend-owned data copies

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

### Requirement: User-scoped attachments SHALL be keyed by explicit user identity
Where a backend needs persistent naming or lookup for `user-identity-state` or
`user-ssh-state`, it SHALL derive that ownership from the selected user
profile.

#### Scenario: Docker user identity naming does not depend only on runtime UNIX user
- **WHEN** a Docker backend names durable user-scoped identity storage
- **THEN** it SHALL key that storage from explicit user profile identity rather
  than only from runtime UNIX user strings such as `root`

