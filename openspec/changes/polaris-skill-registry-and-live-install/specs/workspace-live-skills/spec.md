## ADDED Requirements

### Requirement: Polaris SHALL materialize registered skills at the workspace
layer
The system SHALL install workspace skills by resolving a user registry entry
and materializing it into the target workspace's assistant skill directory for
the selected harness.

#### Scenario: Live install resolves a registered skill
- **WHEN** an operator runs a workspace live-install for a registered skill
- **THEN** Polaris SHALL resolve the user registry entry and install the skill
  into the workspace for the requested harness

#### Scenario: Live install rejects unknown skill ids
- **WHEN** an operator requests live-install for a skill id not present in the
  owning user's registry
- **THEN** Polaris SHALL reject the request without changing the workspace

### Requirement: Polaris SHALL support workspace live uninstall
The system SHALL let operators remove an installed skill from a workspace
without deleting the user registry entry that declared it.

#### Scenario: Live uninstall removes workspace materialization only
- **WHEN** an operator runs a workspace live-uninstall for an installed skill
- **THEN** Polaris SHALL remove the workspace-installed skill files and SHALL
  leave the user registry entry unchanged

#### Scenario: Live uninstall of a missing install is explicit
- **WHEN** an operator runs live-uninstall for a skill that is not installed in
  the workspace
- **THEN** Polaris SHALL return an explicit not-installed result

### Requirement: Polaris SHALL reconcile workspace skill state from the user
registry
The system SHALL provide a workspace sync action that reconciles the installed
workspace skill set to the owning user's declared registry for the selected
harness.

#### Scenario: Sync installs missing registered skills
- **WHEN** a workspace is missing one or more skills declared in the user's
  registry
- **THEN** Polaris SHALL install the missing skills during sync

#### Scenario: Sync removes unmanaged installed skills
- **WHEN** a workspace contains installed skills that are not declared in the
  user's registry for the selected harness
- **THEN** Polaris SHALL remove those unmanaged installs during sync

### Requirement: Polaris SHALL expose installed workspace skills
The system SHALL let operators list currently installed workspace skills by
harness.

#### Scenario: Workspace skill list shows materialized skills
- **WHEN** an operator lists skills for a workspace
- **THEN** Polaris SHALL return the installed skill ids grouped or tagged by
  harness
