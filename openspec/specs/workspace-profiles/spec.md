# workspace-profiles Specification

## Purpose
TBD - created by archiving change workspace-profile-generalization. Update Purpose after archive.
## Requirements
### Requirement: The system SHALL support explicit workspace profiles
The system SHALL support explicit workspace profiles that define reusable backend defaults and workspace defaults without hardcoding one workspace name into backend implementations.

#### Scenario: Morpheus exists as a built-in profile
- **WHEN** the system provides a built-in reference workspace shape
- **THEN** it SHALL provide `morpheus` as a built-in workspace profile rather than as a backend-special-case workspace name

#### Scenario: Profiles provide reusable defaults
- **WHEN** a workspace profile is selected
- **THEN** the profile SHALL be able to provide defaults for backend realization concerns such as image, service defaults, bootstrap defaults, and tooling defaults

### Requirement: Profiles SHALL be backend-neutral at the contract level
Workspace profiles SHALL be expressed at the platform level rather than as one-off backend-specific patches.

#### Scenario: Same profile can be realized by multiple backends
- **WHEN** a workspace profile is used with different backends
- **THEN** each backend SHALL consume the same logical profile inputs while realizing them in backend-specific ways

