## ADDED Requirements

### Requirement: Workspace runtime SHALL assemble auth material from credential
bindings

The system SHALL derive runtime authentication material from explicit workspace
credential bindings before consulting any bounded compatibility path. Runtime
assembly SHALL treat bound credentials as the primary source for SSH, Codex,
and similar authentication inputs.

#### Scenario: Explicit binding overrides legacy profile auth

- **WHEN** a workspace declares an explicit credential binding for a purpose
  that also exists in a legacy profile field
- **THEN** the runtime SHALL assemble auth material from the bound credential
  and SHALL treat the legacy profile field only as compatibility input
