## MODIFIED Requirements

### Requirement: Workspace SHALL be a first-class orchestration object
The system SHALL treat each managed environment as a workspace object with explicit identity, backend selection, attachment-based storage policy, runtime configuration, connectivity settings, lifecycle policy, and health policy. Saved backend specs and generated manifests MUST be derived representations of that workspace object rather than the primary orchestration model, and the saved workspace intent SHALL declare attachment-based storage directly rather than primarily through legacy path-centric persistence fields.

#### Scenario: Workspace intent is normalized before backend rendering
- **WHEN** the TypeScript `agentctl` control plane loads a project configuration
- **THEN** it SHALL normalize the project into a workspace model before generating backend-specific output

#### Scenario: Generated output remains backend-specific
- **WHEN** the normalized workspace is rendered for a target backend
- **THEN** the generated manifest SHALL remain an output artifact and SHALL NOT become the source of truth for workspace behavior
