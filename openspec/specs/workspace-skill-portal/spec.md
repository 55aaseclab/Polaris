# workspace-skill-portal Specification

## Purpose
TBD - created by archiving change polaris-skill-registry-and-live-install. Update Purpose after archive.
## Requirements
### Requirement: The portal SHALL expose a user skill registry management view
The Polaris portal SHALL provide an admin user Skills tab that lists registered
skills for the selected user and supports add and remove actions.

#### Scenario: Admin user view shows registry entries
- **WHEN** an admin opens a user detail page and selects the Skills tab
- **THEN** the portal SHALL show the selected user's registered skills

#### Scenario: Skill add and remove actions call the control plane
- **WHEN** an admin adds or removes a skill from the Skills tab
- **THEN** the portal SHALL persist the change through Polaris server APIs

### Requirement: The portal SHALL expose workspace live skill actions
The Polaris portal SHALL provide workspace-level controls for skill list, live
install, live uninstall, and sync actions.

#### Scenario: Workspace detail shows skill controls
- **WHEN** a user opens a workspace detail page with skill management enabled
- **THEN** the portal SHALL show controls for listing installed skills and
  running live install, live uninstall, and sync

#### Scenario: Workspace live action reports failure clearly
- **WHEN** a workspace skill action fails
- **THEN** the portal SHALL surface the failure result without hiding the
  current installed state

### Requirement: The portal SHALL serve APIs for skill registry and workspace
skill actions
The Polaris server SHALL expose HTTP endpoints for user skill registry reads
and mutations and for workspace live skill actions so the web UI and CLI-backed
services share one control plane.

#### Scenario: User skill APIs are user-scoped
- **WHEN** the portal requests a user's registered skills or mutates that
  registry
- **THEN** the server SHALL scope the request to the selected route user and
  enforce the existing admin or self access rules

#### Scenario: Workspace skill APIs target a workspace explicitly
- **WHEN** the portal requests workspace skill list, live install, live
  uninstall, or sync
- **THEN** the server SHALL execute the action against the explicit workspace
  route target and return the action result

