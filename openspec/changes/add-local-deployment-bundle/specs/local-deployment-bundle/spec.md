## ADDED Requirements

### Requirement: Polaris SHALL provide a stage-one local deployment bundle
for single-machine use
The system SHALL define a stage-one local deployment path for Linux, Windows,
and macOS that is distinct from local development. This deployment path MUST
target single-machine use and MUST use a Docker-only runtime foundation.

#### Scenario: Local deployment scope is explicit
- **WHEN** the local deployment flow is defined
- **THEN** it SHALL identify Linux, Windows, and macOS as supported platforms
- **AND** it SHALL identify Docker as the only supported stage-one runtime
  backend

#### Scenario: Local deployment is not treated as local development
- **WHEN** the deployment documentation or control flow describes stage-one
  local deployment
- **THEN** it SHALL not require a source checkout, development server, or code
  watch process as part of normal user operation

### Requirement: Polaris SHALL expose one shared local control model for GUI
and CLI entry points
The system SHALL define a single local control model that is shared by GUI and
CLI entry points. GUI and CLI MUST expose equivalent lifecycle actions and MUST
not rely on separate runtime implementations.

#### Scenario: GUI and CLI expose the same lifecycle actions
- **WHEN** a local deployment user accesses Polaris through GUI or CLI
- **THEN** the system SHALL provide equivalent actions for install, start,
  stop, status, open, logs, doctor, upgrade, and uninstall

#### Scenario: GUI and CLI share one runtime foundation
- **WHEN** the local deployment bundle starts or stops Polaris
- **THEN** both GUI and CLI SHALL operate on the same local runtime foundation
  and data directory

### Requirement: Polaris SHALL ship stage-one local deployment through native
release artifacts
The system SHALL deliver stage-one local deployment through platform-native
release artifacts rather than requiring users to operate from a source
checkout. At minimum, the release flow MUST support Debian `.deb` artifacts
and Windows `.exe` artifacts.

#### Scenario: Debian release artifact is produced
- **WHEN** the release flow builds stage-one local deployment artifacts for
  Debian
- **THEN** it SHALL produce a `.deb` package that installs the Polaris local
  GUI and CLI entry points

#### Scenario: Windows release artifact is produced
- **WHEN** the release flow builds stage-one local deployment artifacts for
  Windows
- **THEN** it SHALL produce `.exe` artifacts for the Polaris local GUI and CLI
  entry points

### Requirement: Polaris SHALL use one-shot local control actions instead of a
resident control service
The system SHALL define local deployment control actions as one-shot commands
or equivalent one-shot GUI actions. The local deployment bundle MUST NOT
require a separate resident installer daemon or local control service.

#### Scenario: Local control actions exit after completion
- **WHEN** a user runs a local lifecycle action such as install, start, stop,
  or doctor
- **THEN** the action SHALL complete and exit without leaving a dedicated local
  control process running

#### Scenario: Local control service is not a prerequisite
- **WHEN** the system starts a stage-one local deployment
- **THEN** it SHALL not require a previously installed resident Polaris control
  service to be active

### Requirement: Polaris SHALL define standard local deployment prerequisites,
data roots, and diagnostics
The system SHALL define explicit prerequisites, standard data-root conventions,
and user-facing diagnostics for stage-one local deployment.

#### Scenario: Docker prerequisite is checked before install or start
- **WHEN** a user attempts to install or start Polaris locally
- **THEN** the system SHALL verify that the required Docker runtime is
  available
- **AND** it SHALL return a user-facing error when the prerequisite is missing

#### Scenario: Data root is assigned by platform convention
- **WHEN** a local deployment is initialized
- **THEN** the system SHALL assign a persistent local data root using platform
  conventions for Linux, macOS, or Windows

#### Scenario: Diagnostics identify blocking conditions
- **WHEN** a local deployment action cannot proceed
- **THEN** the system SHALL expose diagnostics that identify the blocking
  condition, including at least missing Docker, unavailable ports, or storage
  path failures
