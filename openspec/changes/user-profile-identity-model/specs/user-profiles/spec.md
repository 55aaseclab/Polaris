## ADDED Requirements

### Requirement: The system SHALL expose first-class user profiles
The system SHALL expose a first-class user profile model that owns user
identity defaults separately from workspace profile defaults.

#### Scenario: Workspace selects a user profile
- **WHEN** a workspace spec declares a user profile reference
- **THEN** the control plane SHALL resolve that workspace against the selected
  user profile before backend rendering or lifecycle execution

#### Scenario: User profile owns Git identity defaults
- **WHEN** a user profile is resolved
- **THEN** the control plane SHALL source default Git identity values such as
  user name and email from that user profile rather than from workspace-local
  ad hoc defaults alone

### Requirement: User profiles SHALL own SSH identity policy
Each user profile SHALL define the policy for how user-scoped SSH identity is
provided or generated.

#### Scenario: Managed-key user profile
- **WHEN** a user profile selects `managed-key` SSH mode
- **THEN** the control plane SHALL allow the backend bootstrap flow to generate
  and persist an SSH key for that user-scoped identity if none exists

#### Scenario: Provided-key user profile
- **WHEN** a user profile selects `provided-key` SSH mode
- **THEN** the control plane SHALL require staged SSH private-key material and
  SHALL NOT silently generate a replacement key

### Requirement: User profiles SHALL own external agent identity defaults
The system SHALL treat external Codex and Claude identity defaults as part of
the selected user profile.

#### Scenario: User profile owns external agent identity bundle
- **WHEN** a workspace uses external agent credentials
- **THEN** the control plane SHALL treat the default Codex and Claude identity
  inputs as user-profile-owned state rather than as workspace-profile-owned
  state
