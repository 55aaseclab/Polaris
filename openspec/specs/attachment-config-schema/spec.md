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

### Requirement: Credential material references SHALL map to explicit user attachment classes

The system SHALL represent managed credential material through explicit
credential records whose files map to user-scoped attachment classes. SSH
credential material SHALL resolve through `user-ssh-state`, and harness
credential material such as Codex auth and config SHALL resolve through
`user-identity-state`.

#### Scenario: SSH credential material is user-ssh-state backed

- **WHEN** the system creates or loads a managed SSH credential
- **THEN** the credential material reference SHALL resolve to the user-scoped
  SSH attachment class

#### Scenario: Codex credential material is user-identity-state backed

- **WHEN** the system creates or loads a managed Codex credential
- **THEN** the credential material reference SHALL resolve to the user-scoped
  identity attachment class

### Requirement: Attachment config SHALL expose a netfs source kind for shared
workspace data

The saved attachment config model SHALL support a first-class `netfs` source
kind for durable attachments that are backed by shared network storage. The
source model SHALL preserve backend-neutral location metadata and any
mount-specific options required to realize the same shared store across backend
drivers.

#### Scenario: Saved workspace declares netfs-backed workspace data

- **WHEN** a saved workspace spec declares `workspace-data`
- **THEN** its attachment source SHALL be allowed to use `kind=netfs`

#### Scenario: Netfs config remains authoritative across backends

- **WHEN** a workspace spec declares a `netfs` source for `workspace-data`
- **THEN** Docker, pod, and VM render paths SHALL consume that saved source as
  the authoritative project-data contract

### Requirement: The config model SHALL expose credential registry and
workspace bindings directly

The system SHALL expose a first-class config model for user credential
registry entries and workspace credential bindings. Saved config SHALL allow a
workspace to reference user-owned credentials by id and purpose without
inlining the underlying secret material.

#### Scenario: Workspace config declares credential bindings

- **WHEN** a saved workspace spec declares credential bindings for one or more
  purposes
- **THEN** the config model SHALL preserve those bindings as authoritative input

### Requirement: Direct credential bindings SHALL take precedence over legacy
auth fields

The system SHALL support a bounded compatibility path for legacy auth-related
profile or workspace fields only when direct credential bindings are absent.

#### Scenario: Direct binding wins during config load

- **WHEN** config includes both direct credential bindings and legacy auth
  fields for the same purpose
- **THEN** the loader SHALL treat the direct binding as authoritative

