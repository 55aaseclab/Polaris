## ADDED Requirements

### Requirement: Durable tenant-scoped job lifecycle

Integrated surface jobs SHALL be persisted with tenant, vault, actor,
correlation, dedupe, lease, retry, cancellation, and bounded-result state.

#### Scenario: Restart recovery

- **WHEN** a worker stops while a leased job is running and the lease expires
- **THEN** another permitted worker reclaims or terminally fails the job without
  creating a second logical operation

#### Scenario: Tenant-scoped claim

- **WHEN** a worker claims a queued job
- **THEN** the handler receives only the job's verified tenant and vault context
  and cannot select another root from request data

### Requirement: Registered integrated handlers

Polaris SHALL expose explicit, auditable handlers for provisioning, supported
workflow/analysis completion, bounded derived work, and authorized outbound
actions.

#### Scenario: Unsupported direct surface execution

- **WHEN** integrated Wanghai invokes workflow run or analysis completion
  directly instead of submitting a Polaris job
- **THEN** the surface rejects the action before writing state or invoking a
  tool

#### Scenario: Durable supported submission

- **WHEN** an authorized client submits a supported integrated job
- **THEN** Polaris validates capability and idempotency, persists the job, and
  exposes status without requiring the surface process to run it directly

### Requirement: Bounded worker behavior

Workers SHALL enforce bounded concurrency, lease heartbeats, retry classes,
cancellation, terminal audit, and queue/resource observability.

#### Scenario: Retryable provider failure

- **WHEN** a handler reports a retryable external failure
- **THEN** the job is requeued within its retry budget and the audit records the
  next attempt

#### Scenario: Permanent failure

- **WHEN** a handler reports a permanent or policy failure
- **THEN** the job reaches a terminal state, records the reason, and does not
  retry indefinitely
