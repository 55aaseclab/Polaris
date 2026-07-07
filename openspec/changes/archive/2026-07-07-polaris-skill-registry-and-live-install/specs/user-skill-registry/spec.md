## ADDED Requirements

### Requirement: Polaris SHALL store user-owned skills as declarative registry
entries
The system SHALL let each user maintain a skill registry that stores install
descriptors and metadata without downloading or installing the referenced skill
contents.

#### Scenario: Added skill stays declarative
- **WHEN** an operator adds a skill to a user's registry
- **THEN** Polaris SHALL persist the skill descriptor without downloading or
  unpacking the skill payload

#### Scenario: Listed skills come from the registry
- **WHEN** an operator lists skills for a user
- **THEN** Polaris SHALL return the persisted registry entries for that user

### Requirement: Polaris SHALL preserve an `npx`-compatible install descriptor
for each registered skill
Each registry entry SHALL preserve the source fields needed for workspace
materialization to reconstruct the intended installer command without relying
on host-global installed files.

#### Scenario: Registry entry captures install source data
- **WHEN** an operator adds a skill with a supported source descriptor
- **THEN** Polaris SHALL store the descriptor fields needed to reconstruct the
  workspace install command

#### Scenario: Invalid descriptor is rejected
- **WHEN** an operator adds a skill with missing required source fields
- **THEN** Polaris SHALL reject the entry and leave the user's registry
  unchanged

### Requirement: Polaris SHALL support explicit user skill removal
The system SHALL let operators remove a registry entry without mutating any
workspace until a later workspace action occurs.

#### Scenario: Removing a registry entry does not touch workspaces directly
- **WHEN** an operator removes a skill from a user's registry
- **THEN** Polaris SHALL delete the registry entry and SHALL NOT automatically
  uninstall the skill from every workspace

#### Scenario: Removing an unknown skill fails clearly
- **WHEN** an operator removes a skill id that is not present in the user's
  registry
- **THEN** Polaris SHALL return an explicit not-found error
