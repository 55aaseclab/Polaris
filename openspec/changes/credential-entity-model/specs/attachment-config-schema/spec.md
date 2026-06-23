## ADDED Requirements

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
