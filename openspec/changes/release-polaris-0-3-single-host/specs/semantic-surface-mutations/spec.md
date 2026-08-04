## ADDED Requirements

### Requirement: Idempotent admitted mutation

Every integrated Wanghai unsafe action SHALL use a Polaris-issued or
Polaris-validated idempotency key bound to a normalized request fingerprint.

#### Scenario: First mutation admission

- **WHEN** an authorized client submits a supported mutation with a new valid
  idempotency key
- **THEN** Polaris records the request fingerprint before forwarding and sends a
  scoped admission context to Wanghai

#### Scenario: Duplicate completed mutation

- **WHEN** the same scope and idempotency key are submitted with the same
  fingerprint after completion
- **THEN** Polaris returns the stored bounded result and does not execute the
  Wanghai action again

#### Scenario: Key reuse with different input

- **WHEN** an idempotency key is reused with a different fingerprint
- **THEN** Polaris rejects the request and records a denied audit event

### Requirement: Workspace concurrency protection

Supported integrated mutations SHALL acquire a tenant/vault/workspace lock and
honor an expected workspace version when the action is versioned.

#### Scenario: Concurrent writers

- **WHEN** two clients attempt incompatible writes to the same workspace
- **THEN** at most one admitted action executes and the other receives a
  deterministic conflict or replay response

#### Scenario: Cross-workspace isolation

- **WHEN** a mutation references a workspace outside the verified tenant and
  vault scope
- **THEN** Polaris rejects it before forwarding and Wanghai receives no action

### Requirement: Semantic audit and result

Polaris SHALL write an immutable semantic action record containing the verified
actor, scope, action type, idempotency key digest, request correlation, outcome,
and bounded result metadata without storing customer bodies.

#### Scenario: Successful action audit

- **WHEN** a supported mutation completes
- **THEN** one immutable success record and one durable bounded result can be
  correlated to the request

#### Scenario: Failed action audit

- **WHEN** an admitted mutation fails or is cancelled
- **THEN** the failure outcome and retryability are recorded and a client retry
  cannot silently duplicate the action
