## MODIFIED Requirements

### Requirement: Workspace health SHALL report functional readiness, not only backend liveness
The system SHALL report workspace health in terms of functional readiness,
including backend reachability, runtime readiness, daemon readiness where
applicable, and degraded or failed reasons. Backend liveness alone MUST NOT be
treated as sufficient workspace health. The resolved health result SHALL come
from one canonical control-plane state resolver rather than from independent
status merges in executor, portal, or frontend code.

#### Scenario: Runtime is alive but workspace is degraded
- **WHEN** the backing pod, VM, or container is running but daemon readiness or
  runtime access checks fail
- **THEN** the system SHALL report the workspace as degraded or unavailable
  with the relevant failure reason

#### Scenario: Status distinguishes liveness from readiness
- **WHEN** an operator requests workspace status
- **THEN** the system SHALL distinguish backend liveness from workspace
  readiness in the reported status

#### Scenario: Portal and executor resolve the same health result
- **WHEN** the backend observation has not changed between an action refresh
  and a portal read
- **THEN** both paths SHALL resolve the same workspace health result from the
  canonical control-plane resolver

## ADDED Requirements

### Requirement: Workspace lifecycle state SHALL have one canonical control-plane meaning
The system SHALL maintain one canonical workspace lifecycle state contract for
durable status, live readiness, and in-flight operations. Persisted status
MUST record only fields that represent unique control-plane truth and MUST NOT
retain duplicate derived state that can conflict with live resolution.

#### Scenario: Persisted status excludes duplicated readiness fragments
- **WHEN** the control plane writes workspace status
- **THEN** it SHALL persist only the canonical lifecycle and readiness fields
- **AND** it SHALL NOT preserve superseded duplicate fields solely for display
  convenience

#### Scenario: In-flight lifecycle markers are cleared deterministically
- **WHEN** a lifecycle operation completes, fails, or is superseded by a later
  resolved refresh
- **THEN** the canonical workspace state SHALL clear or replace the in-flight
  operation marker deterministically

