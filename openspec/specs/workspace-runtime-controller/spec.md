# workspace-runtime-controller Specification

## Purpose
TBD - created by archiving change workspace-runtime-controller. Update Purpose after archive.
## Requirements
### Requirement: The control plane SHALL separate observation, drift, status, and reconcile planning
The system SHALL separate backend observation, workspace drift computation, workspace status synthesis, and reconcile planning into distinct control-plane concerns, and all named Polaris backends SHALL participate in that pipeline.

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
The system SHALL execute reconcile behavior from an explicit reconcile plan rather than from an opaque backend-local decision, and the plan SHALL distinguish between attachment repair, runtime assembly repair, manager readiness repair, and evolution-store-safe cleanup.

#### Scenario: Unsupported drift becomes an explicit reconcile outcome
- **WHEN** drift is detected that the current backend or manager adapter cannot repair safely
- **THEN** the reconcile plan SHALL report that unsupported or unrecoverable outcome explicitly

#### Scenario: Safe reconcile actions are categorized
- **WHEN** reconcile planning identifies repairable drift
- **THEN** the plan SHALL categorize the actions to be taken rather than collapsing them into a single unstructured reconcile operation

#### Scenario: Reconcile refuses durable learning-state loss
- **WHEN** a proposed repair would require deleting durable evolution artifacts or user-linked preference state
- **THEN** the reconcile plan SHALL classify that repair as unsafe rather than performing it automatically

### Requirement: Workspace status SHALL expose harness-aware credential selection state

The system SHALL expose structured workspace status fields that let the portal
render harness-aware live credential selection independently from backend and
daemon state.

#### Scenario: Status includes runtime-supported harnesses

- **WHEN** the control plane synthesizes workspace status
- **THEN** it SHALL include the runtime-supported harness list needed to render
  harness-aware selection controls

#### Scenario: Status includes live credential selection information

- **WHEN** the control plane synthesizes workspace status for a workspace with
  live Codex-family credential material
- **THEN** it SHALL report the live credential selection state needed by the
  portal to display the selected credential for that workspace

### Requirement: Runtime status SHALL report credential state separately from infrastructure state

The system SHALL report daemon readiness, harness availability, and credential
selection state as separate concerns. Runtime status SHALL NOT describe missing
or changed credentials as agent infrastructure enable or disable state.

#### Scenario: Workspace has no active Codex credential

- **WHEN** status is synthesized for a workspace whose infrastructure is ready
  but no active Codex credential is selected
- **THEN** the reported status SHALL keep daemon and harness readiness separate
  from credential selection state

#### Scenario: Credential switch does not rewrite infrastructure status

- **WHEN** a user switches the active Codex credential
- **THEN** the reported runtime status SHALL update credential selection state
- **AND** it SHALL NOT report the workspace as becoming agent-enabled or
  agent-disabled solely because of that switch

