## ADDED Requirements

### Requirement: Workspace lifecycle operations SHALL emit structured logs
The system SHALL emit structured operational logs for workspace lifecycle
operations, including start, stop, rebuild, archive, delete, refresh, and
runtime-target publication. Each record SHALL include enough stable context to
correlate the event to one user, one workspace, one driver target, one phase,
and one outcome.

#### Scenario: Lifecycle transition log includes stable identifiers
- **WHEN** Polaris begins or completes a workspace lifecycle operation
- **THEN** it SHALL emit a structured log record containing the user id,
  workspace name, selected driver, action name, and outcome

#### Scenario: Refresh failure log includes concrete cause
- **WHEN** a refresh or executor call fails because of disconnect, timeout, or
  rejected state write
- **THEN** Polaris SHALL emit a structured log record with the failure class
  and the affected workspace identifiers

### Requirement: Workspace timing logs SHALL measure phase latency without mutating status
The system SHALL measure slow workspace phases through logs or diagnostics
rather than by persisting timing-only data into workspace status files.

#### Scenario: Slow iframe-target publication is logged
- **WHEN** runtime target publication or iframe readiness exceeds the defined
  slow-path threshold
- **THEN** Polaris SHALL emit a timing log that identifies the slow phase and
  elapsed duration

#### Scenario: Status persistence excludes timing diagnostics
- **WHEN** Polaris writes the canonical workspace status
- **THEN** the persisted status SHALL NOT include verbose timing traces or
  process-log-only diagnostic payloads
