## ADDED Requirements

### Requirement: Workspace live credential switching SHALL be independent of driver and daemon lifecycle

The system SHALL treat live harness credential switching as a runtime credential
operation, not as driver selection or Paseo daemon lifecycle management.

#### Scenario: Credential switch does not imply driver switch

- **WHEN** an operator changes the selected live Codex credential for a workspace
- **THEN** the system SHALL keep the current workspace driver unchanged

#### Scenario: Credential switch does not require daemon restart

- **WHEN** an operator changes the selected live Codex credential for a running
  workspace
- **THEN** the system SHALL update the runtime credential material without
  requiring a Paseo daemon restart as part of the switch operation

### Requirement: The system SHALL switch live Codex-family credential material in the workspace runtime

The system SHALL support switching the active Codex-family credential by writing
the selected credential material into the workspace runtime's live `.codex`
files for the active backend.

#### Scenario: Docker workspace receives new live Codex material

- **WHEN** an operator switches the selected Codex credential for a docker
  workspace
- **THEN** the system SHALL update the workspace runtime's live `.codex`
  material for that running docker workspace

#### Scenario: Pod workspace receives new live Codex material

- **WHEN** an operator switches the selected Codex credential for a pod workspace
- **THEN** the system SHALL update the workspace runtime's live `.codex`
  material for that running pod workspace

### Requirement: The portal SHALL present harness-aware live credential selection

The portal SHALL expose a harness selector and a harness-filtered credential
selector in the workspace Paseo status page so operators can choose the live
credential inventory relevant to the current runtime.

#### Scenario: Paseo status filters credentials by harness

- **WHEN** an operator selects a harness in the credential selection area
- **THEN** the portal SHALL show only credentials belonging to that harness
  family in the credential selector

#### Scenario: Unsupported live switch remains unavailable

- **WHEN** a harness family does not yet support live runtime switching
- **THEN** the portal SHALL keep the live switch action unavailable rather than
  attempting an undefined runtime mutation
