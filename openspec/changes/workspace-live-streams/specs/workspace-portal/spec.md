## MODIFIED Requirements

### Requirement: The portal SHALL surface live workspace status and runtime
entry points

The system SHALL display current backend state, daemon readiness, and the live
runtime entry point for each workspace. The portal MUST expose workspace
inventory, live workspace summaries, and detail-static workspace payloads as
separate interfaces rather than a single mixed workspace summary response. When
a workspace is ready, the portal MUST show the current live session link or
equivalent runtime access target.

#### Scenario: Ready workspace exposes a live access target
- **WHEN** a workspace is ready
- **THEN** the portal SHALL show the current runtime access target for that
  workspace

#### Scenario: Unready workspace shows the blocking condition
- **WHEN** a workspace is not ready
- **THEN** the portal SHALL show the current blocking state instead of a live
  access target

#### Scenario: Workspace lists use static and live interfaces separately
- **WHEN** the portal serves user-scoped workspace list state
- **THEN** it SHALL provide static workspace inventory separately from live
  workspace summaries
- **AND** it SHALL NOT require detail-only workspace payload fields to keep
  workspace list state current

#### Scenario: Workspace detail uses a detail-static payload
- **WHEN** the portal serves a workspace detail page
- **THEN** it SHALL provide a detail-static workspace payload for assets,
  bindings, and other non-live fields
- **AND** live driver and Paseo state SHALL be consumable independently from
  that detail-static payload
