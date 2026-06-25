## ADDED Requirements

### Requirement: The portal SHALL authenticate users and authorize workspace
access by route user id
The system SHALL use authenticated user identity to authorize access to portal
routes under `/users/<user_id>/workspaces/<workspace_name>`. Normal users MUST
only access their own `user_id`, and admins MUST be able to access other users'
routes.

#### Scenario: Normal user is restricted to self
- **WHEN** an authenticated non-admin user requests a portal route for another
  `user_id`
- **THEN** the system SHALL deny access

#### Scenario: Admin can cross user boundaries
- **WHEN** an authenticated admin user requests a portal route for another
  `user_id`
- **THEN** the system SHALL allow access if the workspace exists and the user
  is otherwise authorized

### Requirement: The portal SHALL derive workspace ownership from the user
project directory
The system SHALL treat `config/users/<user_id>/projects/<workspace_name>/` as
the authoritative source of workspace ownership. The `workspaces:` field in the
user profile SHALL be treated as derived index metadata only.

#### Scenario: Directory ownership is authoritative
- **WHEN** the portal lists or opens a workspace for a user
- **THEN** it SHALL resolve ownership from the corresponding user project
  directory

#### Scenario: Profile index does not override the directory
- **WHEN** the user profile index lists a workspace that does not exist in the
  user project directory
- **THEN** the portal SHALL not treat that workspace as active ownership

### Requirement: The portal SHALL manage user-owned credentials separately
from workspaces
The system SHALL let users manage credentials as user-owned objects, and
workspaces SHALL bind credentials by purpose. Workspace pages MUST expose the
bindings, but credential creation and editing SHALL be user-scoped.

#### Scenario: Credential management is user-scoped
- **WHEN** a user opens their credentials page
- **THEN** the system SHALL show credentials owned by that user only

#### Scenario: Workspace binding is visible on the workspace page
- **WHEN** a user opens a workspace detail page
- **THEN** the system SHALL show the credentials bound to that workspace by
  purpose

### Requirement: The portal SHALL support all four driver profiles
The system SHALL support workspace driver choices for `docker`,
`pod:gvisor`, `pod:data-container`, and `kubevirt-vm`. The portal MUST expose
these profiles as selectable runtime targets for each workspace.

#### Scenario: Pod profiles stay under one backend kind
- **WHEN** a user chooses a pod runtime
- **THEN** the system SHALL treat `gvisor` and `data-container` as profiles
  under the `pod` backend kind

#### Scenario: Driver selection is explicit in the route
- **WHEN** a user opens a driver page for a workspace
- **THEN** the system SHALL identify the target using the workspace route plus
  the selected driver profile

### Requirement: Workspace creation SHALL block until provisioning is complete
The system SHALL make workspace creation a blocking provisioning flow that
creates the workspace directory, all supported driver specs, generated
manifests, and required images before the workspace is considered ready.

#### Scenario: Workspace creation waits for all drivers
- **WHEN** a user creates a workspace
- **THEN** the system SHALL not mark creation complete until all required driver
  specs, manifests, and images are provisioned

#### Scenario: Provisioning progress remains visible after navigation
- **WHEN** provisioning is still in progress and the user leaves the page
- **THEN** the portal SHALL preserve progress state so the user can return later
  and resume viewing it

### Requirement: The portal SHALL surface live workspace status and runtime
entry points
The system SHALL display current backend state, daemon readiness, and the live
runtime entry point for each workspace. When a workspace is ready, the portal
MUST show the current live session link or equivalent runtime access target.

#### Scenario: Ready workspace exposes a live access target
- **WHEN** a workspace is ready
- **THEN** the portal SHALL show the current runtime access target for that
  workspace

#### Scenario: Unready workspace shows the blocking condition
- **WHEN** a workspace is not ready
- **THEN** the portal SHALL show the current blocking state instead of a live
  access target
