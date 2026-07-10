## ADDED Requirements

### Requirement: The system SHALL expose a user-scoped AI Access panel in the admin pane

The system SHALL provide an `AI Access` tab for a selected user in the admin
pane and SHALL present product-level access information instead of provider key
or credential plumbing in its primary surface.

#### Scenario: Admin opens AI Access for a selected user
- **WHEN** an admin navigates to a selected user's detail view
- **THEN** the system SHALL render an `AI Access` tab for that user
- **AND** the tab SHALL summarize access state, billing mode, available
  balance, and referral availability without requiring the admin to inspect
  provider credential files

### Requirement: The system SHALL normalize provider facts into a pay-as-you-go access state

The system SHALL derive a normalized user-facing state model from provider and
runtime facts and SHALL use `not_provisioned`, `funding_needed`, `ready`, or
`error` as the stable primary states for the panel.

#### Scenario: User has not been provisioned with provider access
- **WHEN** the provider facts show that no linked access account exists for the
  selected user
- **THEN** the system SHALL show the `not_provisioned` state
- **AND** the primary action SHALL be `Provision Access`

#### Scenario: User has access but no usable funding
- **WHEN** the provider facts show that the selected user is provisioned but
  has neither usable balance nor an active funding entitlement
- **THEN** the system SHALL show the `funding_needed` state
- **AND** the primary action SHALL be `Top Up`

#### Scenario: User has funded access and runtime is ready
- **WHEN** the provider facts show that the selected user is provisioned and
  funded
- **AND** Polaris runtime readiness has been satisfied
- **THEN** the system SHALL show the `ready` state

### Requirement: The system SHALL treat runtime setup as automatic background work

The system SHALL automatically reconcile provider-backed access with internal
runtime setup, including token or credential materialization needed by Polaris,
instead of exposing setup as a normal user-facing step.

#### Scenario: Funding becomes available for a provisioned user
- **WHEN** a provisioned user gains usable funding through a supported pay-as-
  you-go flow
- **THEN** the system SHALL attempt any required runtime setup automatically
- **AND** the system SHALL not require a separate user-facing `Complete Setup`
  step before the user can become `ready`

#### Scenario: Automatic setup fails
- **WHEN** background runtime setup cannot complete for an otherwise funded user
- **THEN** the system SHALL surface the `error` state instead of a stable setup-
  pending state
- **AND** the system SHALL expose a retry-oriented action path for admins

### Requirement: The system SHALL support provider-agnostic AI Access facts and actions

The system SHALL consume AI Access facts and actions through a provider adapter
model so the panel is not coupled to one provider backend's API shape or naming.

#### Scenario: First adapter uses New API
- **WHEN** Polaris is configured to use `New API` as the AI access backend
- **THEN** the system SHALL map `New API` provisioning, funding, and referral
  data into the normalized AI Access facts model
- **AND** the UI SHALL continue to present the generic `AI Access` product
  surface rather than a provider-branded console

#### Scenario: Unsupported provider capability
- **WHEN** the configured provider does not support one optional AI Access
  capability such as referral data
- **THEN** the system SHALL degrade that portion of the panel gracefully
- **AND** the system SHALL continue to render the remaining supported summary
  and actions

### Requirement: The system SHALL confine provider diagnostics to an advanced admin section

The system SHALL keep provider-specific token, key, and credential-sync details
out of the primary AI Access experience and SHALL expose them only through an
advanced diagnostics area for admins.

#### Scenario: Admin inspects advanced diagnostics
- **WHEN** an admin expands the advanced section of the AI Access tab
- **THEN** the system SHALL show available internal diagnostics such as provider
  backend identity, internal linkage state, setup status, and recent error
  information

#### Scenario: Admin views the primary AI Access surface
- **WHEN** the AI Access tab is shown without expanding advanced diagnostics
- **THEN** the system SHALL not require the admin to read raw API keys, token
  identifiers, or credential file paths to understand the user's product state
