# attachment-config-schema Specification

## Purpose
TBD - created by archiving change attachment-config-schema. Update Purpose after archive.
## Requirements
### Requirement: The system SHALL expose attachment classes as first-class config
The system SHALL allow saved workspace specs to declare attachment classes directly rather than requiring persistence semantics to be inferred from legacy path-centric fields.

#### Scenario: Saved spec declares attachment classes directly
- **WHEN** a user writes a workspace spec
- **THEN** the spec SHALL be able to declare `workspace-data`, `workspace-runtime-state`, `user-identity-state`, `user-ssh-state`, and `ephemeral-runtime` directly

#### Scenario: Attachment declarations are treated as authoritative
- **WHEN** a saved workspace spec includes direct attachment declarations
- **THEN** the control plane SHALL treat those declarations as the authoritative persistence contract

### Requirement: The system SHALL support a bounded legacy compatibility path
The system SHALL support a bounded compatibility path for legacy persistence fields only when direct attachment declarations are absent.

#### Scenario: Legacy persistence fields are translated only as compatibility input
- **WHEN** a saved workspace spec omits direct attachment declarations but includes legacy persistence fields
- **THEN** the control plane SHALL translate those fields into attachment classes as a compatibility behavior

#### Scenario: Direct attachment config wins over legacy fields
- **WHEN** a saved workspace spec includes both direct attachment declarations and legacy persistence fields
- **THEN** the direct attachment declarations SHALL take precedence

