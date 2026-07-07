## MODIFIED Requirements

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
