## ADDED Requirements

### Requirement: Persistence SHALL be modeled as attachment classes
The system SHALL model durable workspace persistence through explicit attachment classes rather than by persisting a runtime home directory or a flat list of durable paths.

#### Scenario: Workspace intent is expressed as durable attachments
- **WHEN** the control plane models workspace persistence
- **THEN** it SHALL express persistence in terms of attachment classes with defined scope, sharing, and durability semantics

#### Scenario: Runtime paths are assembled from attachments
- **WHEN** runtime paths such as home-local config or SSH locations are exposed inside a workspace
- **THEN** those paths SHALL be treated as assembled views of attachments rather than the persistence contract itself

### Requirement: The system SHALL distinguish workspace-scoped and user-scoped durable attachments
The system SHALL distinguish workspace-scoped durable attachments from user-scoped durable attachments.

#### Scenario: Workspace deletion preserves user-scoped attachments
- **WHEN** a workspace is deleted
- **THEN** user-scoped durable attachments SHALL remain intact

#### Scenario: Workspace restart preserves workspace-scoped durable attachments
- **WHEN** a workspace is restarted or rebuilt
- **THEN** workspace-scoped durable attachments SHALL remain attached to that workspace unless explicitly removed by workspace lifecycle policy

### Requirement: The system SHALL support four durable attachment classes
The system SHALL support four durable attachment classes: `workspace-data`, `workspace-runtime-state`, `user-identity-state`, and `user-ssh-state`.

#### Scenario: `codex` and `claude` map to user identity state
- **WHEN** the control plane classifies durable state for `codex` and `claude`
- **THEN** it SHALL classify that state as `user-identity-state`

#### Scenario: SSH material maps to user SSH state
- **WHEN** the control plane classifies SSH private data, known hosts, or SSH configuration
- **THEN** it SHALL classify that state as `user-ssh-state`

#### Scenario: `paseo` maps to workspace runtime state
- **WHEN** the control plane classifies durable `paseo` state
- **THEN** it SHALL classify that state as `workspace-runtime-state`

#### Scenario: Project data maps to workspace data
- **WHEN** the control plane classifies project/worktree data and workspace-local outputs
- **THEN** it SHALL classify that state as `workspace-data`
