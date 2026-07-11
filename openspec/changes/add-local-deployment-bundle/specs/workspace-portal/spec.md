## ADDED Requirements

### Requirement: The portal SHALL distinguish local deployment entry points
from local development entry points
The system SHALL treat stage-one local deployment as a separate runtime entry
model from local development. Portal-facing local deployment guidance MUST
reference the deployment bundle entry points instead of development-only
scripts.

#### Scenario: Local deployment guidance does not point users to dev-only
entry points
- **WHEN** a user reads Polaris guidance for stage-one local deployment
- **THEN** the system SHALL present deployment bundle entry points
- **AND** it SHALL not present development-only watch or dev-server entry
  points as the default local deployment path

### Requirement: The portal SHALL be able to run from fixed local deployment
artifacts
The system SHALL support stage-one local deployment through fixed artifacts or
fixed images rather than requiring development servers.

#### Scenario: Local deployment does not require a development web server
- **WHEN** Polaris is started through the stage-one local deployment path
- **THEN** the portal SHALL be available without requiring a `vite` development
  server

#### Scenario: Local deployment does not require a code watch process
- **WHEN** Polaris is started through the stage-one local deployment path
- **THEN** the portal and backend SHALL not require source watch processes as a
  prerequisite for normal operation
