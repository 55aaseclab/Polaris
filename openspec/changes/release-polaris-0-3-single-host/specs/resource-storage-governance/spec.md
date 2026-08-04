## ADDED Requirements

### Requirement: Atomic logical quota

Polaris SHALL maintain tenant/vault usage and reservations for active workspace,
cache, runtime, and identity categories and SHALL reject a write atomically
when the configured logical limit would be exceeded.

#### Scenario: Quota reservation succeeds

- **WHEN** a supported mutation requests space within the remaining quota
- **THEN** Polaris reserves it before forwarding and reconciles actual usage
  after completion

#### Scenario: Quota exhaustion

- **WHEN** a mutation would exceed the active workspace or cache limit
- **THEN** Polaris rejects it before the write and records a quota outcome with
  no partial file result

### Requirement: Resource admission and limits

The release profile SHALL declare and enforce CPU, memory, process, ephemeral
storage, and egress limits for each integrated runtime and SHALL reject
provisioning when the host cannot reserve the configured capacity.

#### Scenario: Host capacity unavailable

- **WHEN** admitting another vault would exceed the configured host resource
  budget
- **THEN** Polaris queues or rejects provisioning before starting a partial
  runtime

#### Scenario: Runtime limit breach

- **WHEN** a surface exceeds its process, memory, CPU, or ephemeral-storage
  limit
- **THEN** the supervisor or platform terminates/throttles it, reports the
  condition, and keeps other tenants isolated

### Requirement: Observable resource and quota state

Polaris SHALL expose tenant-safe metrics, structured events, and alerts for
gateway decisions, active tenants, usage, queue depth, job age, resource
pressure, backup failures, and recovery failures.

#### Scenario: Pre-exhaustion alert

- **WHEN** quota, disk, memory, or queue utilization crosses a configured
  warning threshold
- **THEN** an operator-visible alert is emitted before service exhaustion

#### Scenario: Sensitive data exclusion

- **WHEN** a metric, log, trace, or audit record is emitted
- **THEN** it excludes request bodies, credentials, signed assertions, and
  customer-controlled identifiers
