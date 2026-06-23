## ADDED Requirements

### Requirement: Backend switches SHALL preserve shared workspace data without
copy migration

The system SHALL treat shared `workspace-data` as a stable durable attachment
that survives backend switches without export-and-import copying. Backend
switch migration SHALL remain limited to `workspace-runtime-state`,
`user-identity-state`, and `user-ssh-state`.

#### Scenario: Switch migrates only small durable state

- **WHEN** an operator switches a workspace between supported backends
- **THEN** the system SHALL migrate only `workspace-runtime-state`,
  `user-identity-state`, and `user-ssh-state`

#### Scenario: Switch fails when shared data cannot be attached

- **WHEN** the destination backend cannot realize the declared shared
  `workspace-data` source
- **THEN** the switch SHALL fail before reporting the workspace as ready
