## ADDED Requirements

### Requirement: Single-host capacity profile

Polaris SHALL support no more than ten concurrently active integrated user
tenants in the 0.3.0 release profile, using one control-plane host and no
gateway replicas.

#### Scenario: Capacity admission at the release limit

- **WHEN** ten active vaults are admitted and a further vault would exceed the
  configured host capacity
- **THEN** Polaris rejects or queues the new operation deterministically and
  records the capacity reason without creating a partial vault

#### Scenario: Restart preserves the single-host control state

- **WHEN** the Polaris process restarts with its durable control store intact
- **THEN** tenant ownership, tickets, jobs, rate buckets, idempotency records,
  and audit history remain available

### Requirement: Staged release evidence

The release process SHALL produce distinct synthetic evidence at 2, 5, and 10
active users, covering the agreed login, launch, navigation, reads, uploads,
mutations, recovery, and storage-pressure flows.

#### Scenario: Target-stage acceptance

- **WHEN** the ten-user stage completes within the documented SLOs
- **THEN** the evidence records the exact candidate manifest, load generator,
  environment, timestamps, results, and artifacts

#### Scenario: Lower-stage evidence cannot claim the target

- **WHEN** only the two- or five-user stage has passed
- **THEN** the release record keeps the ten-user gate open

### Requirement: Private integrated ingress

No unauthenticated or directly addressable Wanghai service endpoint SHALL be
reachable from the public network.

#### Scenario: Direct port bypass

- **WHEN** a client connects to a former Docker port, NodePort, or forged
  assertion route
- **THEN** the request is unreachable or denied and no Wanghai data is exposed

#### Scenario: Authenticated gateway launch

- **WHEN** an authorized Authing-backed Polaris session launches its selected
  Wanghai vault
- **THEN** a single-use ticket, scoped session, and short-lived assertion are
  used before the private surface is reached
