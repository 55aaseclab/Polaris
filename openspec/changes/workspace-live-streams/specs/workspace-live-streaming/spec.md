## ADDED Requirements

### Requirement: The portal SHALL stream user-scoped live workspace summaries

The portal SHALL expose a user-scoped live workspace stream that publishes
canonical live workspace summaries derived from persisted workspace state. The
stream MUST provide an initial snapshot for the requested user and MUST publish
workspace-level updates when live state changes.

#### Scenario: Subscriber receives an initial snapshot
- **WHEN** an authorized client subscribes to the live workspace stream for a
  user
- **THEN** the portal SHALL send the current live summaries for that user's
  workspaces before sending incremental updates

#### Scenario: Workspace live state change produces an upsert event
- **WHEN** a persisted workspace status change modifies the projected live
  summary for a workspace
- **THEN** the portal SHALL publish an updated live summary for that workspace
  to current subscribers for the owning user

### Requirement: The live workspace stream SHALL be driven by filesystem observation

The portal SHALL detect user workspace live-state changes through filesystem
observation of workspace state and inventory files. Raw watcher events MUST be
treated as invalidation signals only, and the portal MUST recompute canonical
workspace summaries before publishing changes.

#### Scenario: File watcher noise is collapsed into one canonical update
- **WHEN** multiple filesystem events are emitted for one logical workspace
  status write
- **THEN** the portal SHALL debounce the invalidation and publish at most the
  canonical resulting workspace live summary change

#### Scenario: Workspace removal clears live state
- **WHEN** a workspace is removed from the user's workspace inventory
- **THEN** the portal SHALL stop publishing stale live state for that workspace
- **AND** it SHALL publish a removal event to current subscribers for that user
