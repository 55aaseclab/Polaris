# workspace-attachment-lifecycle Specification

## Purpose
TBD - created by archiving change workspace-attachments-persistence-model. Update Purpose after archive.
## Requirements
### Requirement: Attachment classes SHALL define lifecycle scope explicitly
Each attachment class SHALL define whether it is workspace-scoped or user-scoped, whether it is shareable across workspaces, and how it behaves during create, restart, rebuild, and delete operations. These lifecycle rules SHALL be directly expressible and validated through the saved attachment config model.

#### Scenario: User-scoped attachments are reusable across workspaces
- **WHEN** multiple workspaces belong to the same user context
- **THEN** `user-identity-state` and `user-ssh-state` SHALL be reusable across those workspaces

#### Scenario: Workspace-scoped attachments are not shared across workspaces
- **WHEN** multiple workspaces are created
- **THEN** `workspace-data` and `workspace-runtime-state` SHALL remain scoped to their own workspace and SHALL NOT be implicitly shared

### Requirement: The system SHALL define ephemeral runtime state separately from durable attachments
The system SHALL define `ephemeral-runtime` as a non-durable state class separate from the four durable attachment classes.

#### Scenario: Ephemeral runtime state may be recreated on restart
- **WHEN** a workspace is restarted or reconciled
- **THEN** ephemeral runtime state such as pid files, sockets, and temp state MAY be recreated or removed without being treated as durable data loss

#### Scenario: Durable attachments are not cleaned as ephemeral state
- **WHEN** the system performs ephemeral runtime cleanup
- **THEN** it SHALL NOT treat any durable attachment class as a cleanup target

### Requirement: Backend drivers SHALL implement attachment semantics consistently
Backend drivers SHALL map the same attachment classes onto backend-specific storage primitives without changing the scope, sharing, or lifecycle meaning of those classes.

#### Scenario: Pod and VM backends preserve the same attachment meaning
- **WHEN** the same logical workspace is realized on `pod` and `kubevirt-vm` backends
- **THEN** the meaning of each attachment class SHALL remain consistent even if the physical mount implementation differs

#### Scenario: Docker legacy backend still exposes attachment semantics
- **WHEN** the docker backend is used during migration
- **THEN** it SHALL still expose the same attachment-class semantics even if its implementation remains transitional or legacy-backed

