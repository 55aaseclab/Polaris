## MODIFIED Requirements

### Requirement: The portal SHALL surface live workspace status and runtime
entry points
The system SHALL display current backend state, daemon readiness, and the live
runtime entry point for each workspace. When a workspace is ready, the portal
MUST show the current live session link or equivalent runtime access target.
The portal MUST render workspace state from the canonical control-plane
contract and MUST NOT invent competing lifecycle truth in pane-local caches or
display adapters.

#### Scenario: Ready workspace exposes a live access target
- **WHEN** a workspace is ready
- **THEN** the portal SHALL show the current runtime access target for that
  workspace

#### Scenario: Unready workspace shows the blocking condition
- **WHEN** a workspace is not ready
- **THEN** the portal SHALL show the current blocking state instead of a live
  access target

#### Scenario: Admin and user routes show the same lifecycle state
- **WHEN** an admin view and a user-scoped view load the same workspace after
  the same resolved backend state
- **THEN** both routes SHALL show the same lifecycle state and readiness

## ADDED Requirements

### Requirement: Portal workspace actions SHALL follow the canonical lifecycle contract
The portal SHALL enable, disable, and refresh workspace actions according to
the canonical lifecycle contract returned by Polaris rather than by action-
specific frontend heuristics.

#### Scenario: In-flight action disables conflicting controls
- **WHEN** Polaris reports a workspace as being in an in-flight lifecycle
  operation
- **THEN** the portal SHALL disable conflicting controls until the canonical
  state changes

#### Scenario: Iframe mounting waits for canonical runtime readiness
- **WHEN** the workspace route resolves without a ready runtime entry target
- **THEN** the portal SHALL avoid mounting or reconnecting the embedded runtime
  frame until the canonical workspace state exposes a valid runtime target

