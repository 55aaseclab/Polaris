## ADDED Requirements

### Requirement: Workspace status SHALL expose harness-aware credential selection state

The system SHALL expose structured workspace status fields that let the portal
render harness-aware live credential selection independently from backend and
daemon state.

#### Scenario: Status includes runtime-supported harnesses

- **WHEN** the control plane synthesizes workspace status
- **THEN** it SHALL include the runtime-supported harness list needed to render
  harness-aware selection controls

#### Scenario: Status includes live credential selection information

- **WHEN** the control plane synthesizes workspace status for a workspace with
  live Codex-family credential material
- **THEN** it SHALL report the live credential selection state needed by the
  portal to display the selected credential for that workspace
