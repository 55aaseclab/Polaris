## ADDED Requirements

### Requirement: The web app SHALL use a user-scoped workspace store

The web app SHALL model user workspace inventory and live workspace state
through a reusable user-scoped `UserWorkspaceStore`. The store MUST separate
static workspace inventory from live workspace summaries and MUST expose the
current live connection state for its user scope.

#### Scenario: Static and live data are stored separately
- **WHEN** the web app initializes a user-scoped workspace store
- **THEN** it SHALL keep workspace inventory and live workspace summaries as
  separate state collections rather than a single mixed workspace summary array

#### Scenario: Store connection state is observable
- **WHEN** the live workspace stream connects, reconnects, or fails
- **THEN** the user-scoped workspace store SHALL expose that connection state
  to its consumers

### Requirement: PortalShell SHALL consume only the new workspace store interfaces

`PortalShell` SHALL bootstrap from static workspace inventory and live workspace
stream interfaces and SHALL NOT depend on the legacy mixed workspace summary
response for its workspace state.

#### Scenario: Sidebar uses static inventory plus live state
- **WHEN** `PortalShell` renders the workspace sidebar
- **THEN** it SHALL derive the workspace list from static workspace inventory
- **AND** it SHALL derive driver and Paseo live state from the user-scoped
  workspace store's live summaries

#### Scenario: Workspace detail reads live state from the shared store
- **WHEN** a workspace detail page is open inside `PortalShell`
- **THEN** it SHALL read live driver and Paseo state from the shell-owned
  user-scoped workspace store instead of running recurring status polling loops
