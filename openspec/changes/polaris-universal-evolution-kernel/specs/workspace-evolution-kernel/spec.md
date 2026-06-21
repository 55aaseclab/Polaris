## ADDED Requirements

### Requirement: Polaris SHALL provide a manager-agnostic workspace evolution kernel
The system SHALL provide a Polaris-native evolution kernel that captures normalized agent-manager execution history, derives structured learning artifacts, and makes those artifacts available to future workspace runs independently of any single manager implementation.

#### Scenario: Paseo participates through an adapter
- **WHEN** a workspace uses Paseo as its configured manager
- **THEN** the evolution kernel SHALL consume Paseo execution data through a manager adapter rather than through Paseo-specific persistence as the kernel's source of truth

#### Scenario: Future managers use the same evolution contract
- **WHEN** a future manager is introduced for Polaris workspaces
- **THEN** the evolution kernel SHALL be able to consume that manager through the same normalized adapter contract without redefining the workspace evolution model

### Requirement: The evolution kernel SHALL separate workspace knowledge from user-linked preferences
The system SHALL store workspace-scoped operational knowledge separately from user-linked long-lived preferences and identity-related recall.

#### Scenario: Workspace lesson remains local
- **WHEN** a reviewer derives a debugging lesson, validation recipe, or playbook from one workspace's execution history
- **THEN** the system SHALL classify that artifact as workspace-scoped and SHALL NOT automatically expose it to unrelated workspaces

#### Scenario: User preference follows the selected user profile
- **WHEN** a reviewer derives a durable operator preference or execution-style preference
- **THEN** the system SHALL associate that artifact with the selected user profile identity rather than with the runtime UNIX user string alone

### Requirement: The evolution kernel SHALL use structured artifact kinds
The system SHALL represent reviewer output as structured artifact kinds rather than as untyped notes.

#### Scenario: Reviewer emits typed artifact
- **WHEN** an asynchronous review run produces a new learning item
- **THEN** the system SHALL classify it as a typed artifact such as `user-preference`, `workspace-playbook`, `verified-lesson`, or `discarded-observation`

#### Scenario: Retrieval filters by artifact type and scope
- **WHEN** a future workspace run requests relevant learning context
- **THEN** the system SHALL be able to retrieve artifacts by type, scope, and relevance rather than only by raw chronological order

### Requirement: The evolution kernel SHALL support review, retrieval, and curation phases
The system SHALL treat learning as a phased pipeline of capture, review, retrieval, and curation rather than as immediate unconditional persistence.

#### Scenario: Review writes to the evolution store only
- **WHEN** a reviewer run decides that a learning item should be persisted
- **THEN** it SHALL write the structured artifact to the evolution store and SHALL NOT directly mutate external manager-private skill or identity directories

#### Scenario: Curator reconciles stale or overlapping artifacts
- **WHEN** the evolution store contains stale, low-confidence, or overlapping artifacts
- **THEN** the system SHALL support curator actions that merge, archive, decay, or suppress those artifacts without deleting the underlying workspace runtime history
