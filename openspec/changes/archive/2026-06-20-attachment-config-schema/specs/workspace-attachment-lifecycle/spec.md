## MODIFIED Requirements

### Requirement: Attachment classes SHALL define lifecycle scope explicitly
Each attachment class SHALL define whether it is workspace-scoped or user-scoped, whether it is shareable across workspaces, and how it behaves during create, restart, rebuild, and delete operations. These lifecycle rules SHALL be directly expressible and validated through the saved attachment config model.

#### Scenario: User-scoped attachments are reusable across workspaces
- **WHEN** multiple workspaces belong to the same user context
- **THEN** `user-identity-state` and `user-ssh-state` SHALL be reusable across those workspaces

#### Scenario: Workspace-scoped attachments are not shared across workspaces
- **WHEN** multiple workspaces are created
- **THEN** `workspace-data` and `workspace-runtime-state` SHALL remain scoped to their own workspace and SHALL NOT be implicitly shared
