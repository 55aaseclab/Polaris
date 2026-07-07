## ADDED Requirements

### Requirement: Workspace data SHALL support a backend-stable shared source

The system SHALL allow `workspace-data` to be realized from a shared source
that remains stable across backend changes. When `workspace-data` uses a shared
source, the workspace spec SHALL remain the single source of truth for that
project store instead of deriving separate backend-local copies.

#### Scenario: Project data remains one logical attachment across drivers

- **WHEN** the same workspace is rendered for Docker and pod-oriented backends
- **THEN** `workspace-data` SHALL refer to one logical shared project store
  rather than separate backend-owned data copies
