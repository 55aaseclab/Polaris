# workspace-backend-observation Specification

## Purpose
TBD - created by archiving change workspace-runtime-controller. Update Purpose after archive.
## Requirements
### Requirement: Backend drivers SHALL return structured observations
Backend drivers SHALL return structured live observations about their workspace instances instead of only returning coarse status values or executing blind actions. This requirement applies to `pod`, `kubevirt-vm`, and `docker` as named Polaris backends.

#### Scenario: Pod backend reports live runtime evidence
- **WHEN** the pod backend inspects a workspace
- **THEN** it SHALL return structured observations about backend existence, runtime state, attachments, runtime assembly, daemon evidence, and services

#### Scenario: KubeVirt reports structured live backend evidence
- **WHEN** the KubeVirt backend inspects a workspace
- **THEN** it SHALL return structured observations at meaningful operational fidelity rather than only object-existence placeholders

#### Scenario: Docker reports structured live backend evidence
- **WHEN** the Docker backend inspects a workspace
- **THEN** it SHALL return structured observations at meaningful operational fidelity rather than only legacy unsupported placeholders

### Requirement: Observations SHALL be backend evidence, not final control-plane judgment
The system SHALL treat backend observations as evidence to be interpreted by the control plane rather than as final workspace truth.

#### Scenario: Backend does not decide final readiness alone
- **WHEN** a backend reports observations
- **THEN** the control plane SHALL use those observations to derive workspace status rather than exposing them unchanged as the final user-facing result

