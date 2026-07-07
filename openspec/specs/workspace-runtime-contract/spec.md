# workspace-runtime-contract Specification

## Purpose
TBD - created by archiving change coder-inspired-workspace-orchestration. Update Purpose after archive.
## Requirements
### Requirement: Workspace runtime SHALL classify managed filesystem and process state
The system SHALL classify managed workspace runtime state into two categories:
minimal runtime invariants and stale runtime artifacts. Durable persistence
semantics MUST be defined through attachment classes rather than through the
runtime contract, and these runtime concerns SHALL feed into drift detection
and reconcile planning rather than only static validation.

#### Scenario: Durable attachments are not defined by runtime-path persistence
- **WHEN** the control plane defines durable state semantics
- **THEN** it SHALL define them through attachment classes rather than by
  declaring a runtime home or flat durable path list

#### Scenario: Stale runtime artifacts are safe cleanup targets
- **WHEN** the system detects stale runtime artifacts such as pid files,
  sockets, or transient leftovers
- **THEN** it SHALL allow cleanup of those artifacts without treating that
  cleanup as durable-state mutation

### Requirement: Workspace runtime SHALL enforce structural invariants deterministically
The system SHALL enforce required structural invariants for a managed
workspace, including canonical runtime path assembly, required directories,
ownership rules, permission modes, dependency/source-path sanity checks, and
selected user-profile identity material. Structural invariant enforcement MUST
be deterministic and MUST avoid destructive mutation of durable attachments.

#### Scenario: Required runtime structure is restored safely
- **WHEN** a managed workspace is missing a required directory or has a
  non-canonical runtime link that is classified as a structural invariant issue
- **THEN** the system SHALL restore the required structure without deleting
  durable user or workspace attachments

#### Scenario: Ownership and mode violations are treated as invariant failures
- **WHEN** required ownership or permission modes for managed runtime paths do
  not match the declared runtime contract
- **THEN** the system SHALL report and reconcile the mismatch as a structural
  invariant failure

### Requirement: Workspace health SHALL report functional readiness, not only backend liveness
The system SHALL report workspace health in terms of functional readiness,
including backend reachability, runtime readiness, daemon readiness where
applicable, and degraded or failed reasons. Backend liveness alone MUST NOT be
treated as sufficient workspace health.

#### Scenario: Runtime is alive but workspace is degraded
- **WHEN** the backing pod, VM, or container is running but daemon readiness or
  runtime access checks fail
- **THEN** the system SHALL report the workspace as degraded or unavailable
  with the relevant failure reason

#### Scenario: Status distinguishes liveness from readiness
- **WHEN** an operator requests workspace status
- **THEN** the system SHALL distinguish backend liveness from workspace
  readiness in the reported status

### Requirement: Runtime reconciliation SHALL be explicit and auditable
The system SHALL treat runtime cleanup and repair as explicit reconcile
behavior and SHALL surface what class of issue was detected and what class of
action was taken.

#### Scenario: Reconcile reports cleanup scope
- **WHEN** reconcile removes stale runtime artifacts or restores structural
  invariants
- **THEN** the system SHALL report whether it cleaned stale artifacts,
  restored structural invariants, or refused an action because it would affect
  durable state

#### Scenario: Unsafe repair is rejected
- **WHEN** a proposed automatic repair would require mutating data classified as
  durable state
- **THEN** the system SHALL reject that repair as an automatic reconcile action

### Requirement: Runtime assembly SHALL mount active user harness credentials into standard paths

The system SHALL assemble active user harness credentials into the standard
runtime-visible paths for each supported harness. Harness credential material
selection SHALL be independent from whether the harness CLI is installed.

#### Scenario: Active Codex credential is assembled

- **WHEN** a workspace runtime is assembled for a user with an active Codex
  credential
- **THEN** the system SHALL mount that credential's auth and config material
  into the standard Codex runtime paths

#### Scenario: No active Codex credential is selected

- **WHEN** a workspace runtime is assembled for a user without an active Codex
  credential
- **THEN** the system SHALL omit Codex credential material from the assembled
  runtime
- **AND** the system SHALL NOT treat that omission as removing Codex tooling

### Requirement: Harness tooling SHALL come from a shared tool catalog

The system SHALL provision workspace harness tooling from a shared catalog so
that supported harnesses are declared consistently across workspace backends.

#### Scenario: Shared harness catalog is used during bootstrap

- **WHEN** workspace tooling is bootstrapped for a backend
- **THEN** the backend bootstrap flow SHALL use the shared harness catalog to
  determine which CLIs to provision

#### Scenario: First-phase harness catalog

- **WHEN** the first phase of this change is applied
- **THEN** the shared harness catalog SHALL include `codex`, `claude`,
  `copilot`, `opencode`, and `pi`

### Requirement: Workspace runtime SHALL assemble auth material from credential
bindings

The system SHALL derive runtime authentication material from explicit workspace
credential bindings before consulting any bounded compatibility path. Runtime
assembly SHALL treat bound credentials as the primary source for SSH, Codex,
and similar authentication inputs.

#### Scenario: Explicit binding overrides legacy profile auth

- **WHEN** a workspace declares an explicit credential binding for a purpose
  that also exists in a legacy profile field
- **THEN** the runtime SHALL assemble auth material from the bound credential
  and SHALL treat the legacy profile field only as compatibility input

### Requirement: Runtime-visible Git and SSH identity SHALL derive from selected user profile
The system SHALL derive runtime-visible Git and SSH identity defaults from the
selected user profile rather than only from workspace-local tooling values or
workspace profile defaults.

#### Scenario: Git identity comes from user profile
- **WHEN** Polaris bootstraps Git configuration inside a workspace
- **THEN** the default user name and email SHALL come from the selected user
  profile

#### Scenario: SSH key comment comes from user profile
- **WHEN** Polaris generates or validates a managed SSH key
- **THEN** the SSH key comment SHALL come from the selected user profile rather
  than from the selected workspace profile

