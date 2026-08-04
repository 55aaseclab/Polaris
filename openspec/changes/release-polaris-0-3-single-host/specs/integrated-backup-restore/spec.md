## ADDED Requirements

### Requirement: Encrypted tenant-qualified backup

Polaris SHALL create encrypted, checksummed backups for one verified tenant and
vault, with retention metadata and no customer secrets in logs or manifests.

#### Scenario: Successful backup

- **WHEN** an authorized backup job runs for a selected vault
- **THEN** the archive is encrypted, checksum-verified, tenant/vault-bound, and
  recorded with retention and audit metadata

#### Scenario: Cross-tenant backup denial

- **WHEN** a request attempts to back up a vault outside its verified scope
- **THEN** Polaris denies it before reading the source root

### Requirement: Safe restore target

Restore SHALL verify archive integrity and restore only into a new
tenant-qualified root before any activation or replacement.

#### Scenario: Restore verification

- **WHEN** a valid archive is restored to a new target
- **THEN** the tree, manifest, checksum, and tenant/vault binding are verified
  before the target is offered for activation

#### Scenario: Unsafe target

- **WHEN** a restore target is absolute, traverses outside the configured
  backup/data roots, already belongs to another tenant, or is modified after
  verification
- **THEN** Polaris refuses the restore without mutating the original root

### Requirement: Restore rollback and audit

Polaris SHALL support an explicit rollback of a failed restore and immutable
records for backup, restore, activation, and rollback outcomes.

#### Scenario: Failed restore rollback

- **WHEN** verification or activation fails after a target was created
- **THEN** Polaris removes only the unchanged target or preserves it for repair,
  leaves the original root intact, and records the outcome

#### Scenario: Retention cleanup

- **WHEN** retention cleanup runs
- **THEN** it deletes only expired archives belonging to the selected tenant and
  records the cleanup result
