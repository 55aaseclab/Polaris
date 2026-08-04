## ADDED Requirements

### Requirement: Immutable candidate manifest

Every 0.3.0 candidate SHALL identify exact Polaris, workspace-base, Wanghai
image, migration, resource, and quota versions using immutable digests or
content hashes.

#### Scenario: Mutable artifact rejection

- **WHEN** a candidate references latest, an unpinned tag, or an unavailable
  artifact
- **THEN** promotion fails before building or changing traffic

#### Scenario: Complete manifest

- **WHEN** a candidate manifest is submitted
- **THEN** all required digests, configuration versions, owners, and evidence
  references are present and machine-validated

### Requirement: Signed supply-chain evidence

Promotion SHALL verify a signature, SBOM, and provenance attestation for each
promoted image before deployment.

#### Scenario: Missing signature

- **WHEN** an image has a digest but no valid signature or provenance
- **THEN** promotion fails closed and records the missing evidence

#### Scenario: Verified promotion

- **WHEN** all artifacts and attestations verify
- **THEN** one deployment lock permits the candidate to deploy and the
  manifest is recorded immutably

### Requirement: Verified rollback

The release system SHALL retain the previous verified manifest and SHALL allow
rollback to it without changing tenant data roots.

#### Scenario: Rollback after failed smoke

- **WHEN** post-deploy smoke or capacity evidence fails
- **THEN** traffic returns to the previous verified manifest and the failure is
  recorded without deleting tenant data
