## MODIFIED Requirements

### Requirement: The system SHALL produce structured workspace drift
The system SHALL represent drift between declared workspace intent and observed live backend state as structured drift items, including attachment drift, runtime assembly drift, manager readiness drift, and evolution-state drift where applicable.

#### Scenario: Attachment drift is represented explicitly
- **WHEN** an expected attachment is missing, mismatched, or drifted in live runtime state
- **THEN** the control plane SHALL represent that condition as structured drift

#### Scenario: Runtime assembly drift is represented explicitly
- **WHEN** runtime-visible paths or manager-related assembly do not match the declared workspace model
- **THEN** the control plane SHALL represent that condition as structured drift

#### Scenario: Manager-specific readiness is normalized
- **WHEN** the configured manager exposes readiness or state surfaces through its contract
- **THEN** the control plane SHALL represent readiness failures as structured drift without assuming Paseo-specific targets

## MODIFIED Requirements

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
