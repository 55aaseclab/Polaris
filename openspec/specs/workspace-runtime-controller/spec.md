# workspace-runtime-controller Specification

## Purpose
TBD - created by archiving change workspace-runtime-controller. Update Purpose after archive.
## Requirements
### Requirement: The control plane SHALL separate observation, drift, status, and reconcile planning
The system SHALL separate backend observation, workspace drift computation, workspace status synthesis, and reconcile planning into distinct control-plane concerns.

#### Scenario: Control plane computes status from observations
- **WHEN** a backend returns live observations for a workspace
- **THEN** the control plane SHALL compute workspace drift and synthesize workspace status from those observations rather than treating the backend response as the final status

#### Scenario: Control plane plans reconcile before execution
- **WHEN** reconcile is requested
- **THEN** the control plane SHALL build a reconcile plan before backend execution begins

### Requirement: The system SHALL produce structured workspace drift
The system SHALL represent drift between declared workspace intent and observed live backend state as structured drift items.

#### Scenario: Attachment drift is represented explicitly
- **WHEN** an expected attachment is missing, mismatched, or drifted in live runtime state
- **THEN** the control plane SHALL represent that condition as structured drift

#### Scenario: Runtime assembly drift is represented explicitly
- **WHEN** runtime-visible paths or daemon-related assembly do not match the declared workspace model
- **THEN** the control plane SHALL represent that condition as structured drift

### Requirement: Reconcile SHALL execute from an explicit plan
The system SHALL execute reconcile behavior from an explicit reconcile plan rather than from an opaque backend-local decision.

#### Scenario: Unsupported drift becomes an explicit reconcile outcome
- **WHEN** drift is detected that the current backend cannot repair safely
- **THEN** the reconcile plan SHALL report that unsupported or unrecoverable outcome explicitly

#### Scenario: Safe reconcile actions are categorized
- **WHEN** reconcile planning identifies repairable drift
- **THEN** the plan SHALL categorize the actions to be taken rather than collapsing them into a single unstructured reconcile operation

