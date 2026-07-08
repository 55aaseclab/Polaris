## MODIFIED Requirements

### Requirement: Observations SHALL be backend evidence, not final control-plane judgment
The system SHALL treat backend observations as evidence to be interpreted by
the control plane rather than as final workspace truth. A single control-plane
resolver SHALL derive the canonical workspace lifecycle and readiness result
from that evidence for executor actions, background refreshes, and portal
reads.

#### Scenario: Backend does not decide final readiness alone
- **WHEN** a backend reports observations
- **THEN** the control plane SHALL use those observations to derive workspace
  status rather than exposing them unchanged as the final user-facing result

#### Scenario: Refresh and action paths share one observation resolver
- **WHEN** the control plane evaluates the same backend observation during an
  explicit action and during a later refresh
- **THEN** both paths SHALL use the same resolver contract to derive workspace
  state

## ADDED Requirements

### Requirement: Backend observation SHALL expose resolution-ready evidence
Backend observation outputs SHALL contain the structured evidence needed for
the control plane to resolve lifecycle state without inferring hidden meaning
from unrelated fields or UI-local context.

#### Scenario: Observation exposes blocking evidence explicitly
- **WHEN** a workspace is not ready because of runtime, attachment, or daemon
  issues
- **THEN** the observation SHALL expose explicit blocking evidence that the
  control plane can convert into a canonical reason

#### Scenario: Observation does not rely on frontend recomputation
- **WHEN** the portal reads workspace detail or summary data
- **THEN** it SHALL receive control-plane-resolved workspace state rather than
  having to recompute lifecycle meaning from raw backend evidence

