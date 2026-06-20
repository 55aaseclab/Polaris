# workspace-backend-observation Specification

## Purpose
TBD - created by archiving change workspace-runtime-controller. Update Purpose after archive.
## Requirements
### Requirement: Backend drivers SHALL return structured observations
Backend drivers SHALL return structured live observations about their workspace instances instead of only returning coarse status values or executing blind actions.

#### Scenario: Pod backend reports live runtime evidence
- **WHEN** the pod backend inspects a workspace
- **THEN** it SHALL return structured observations about backend existence, runtime state, attachments, runtime assembly, daemon evidence, and services

#### Scenario: Lower-fidelity backends still report observations
- **WHEN** kubevirt-vm or docker cannot yet report full runtime fidelity
- **THEN** they SHALL still return structured observations at the fidelity they support rather than bypassing the observation model entirely

### Requirement: Observations SHALL be backend evidence, not final control-plane judgment
The system SHALL treat backend observations as evidence to be interpreted by the control plane rather than as final workspace truth.

#### Scenario: Backend does not decide final readiness alone
- **WHEN** a backend reports observations
- **THEN** the control plane SHALL use those observations to derive workspace status rather than exposing them unchanged as the final user-facing result

