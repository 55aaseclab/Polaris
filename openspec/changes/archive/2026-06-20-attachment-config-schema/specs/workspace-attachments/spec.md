## MODIFIED Requirements

### Requirement: Persistence SHALL be modeled as attachment classes
The system SHALL model durable workspace persistence through explicit attachment classes and SHALL expose those attachment classes directly in the saved workspace config model rather than only as an internal representation derived from legacy fields.

#### Scenario: Workspace intent is expressed as durable attachments
- **WHEN** the control plane models workspace persistence
- **THEN** it SHALL express persistence in terms of attachment classes with defined scope, sharing, and durability semantics

#### Scenario: Runtime paths are assembled from attachments
- **WHEN** runtime paths such as home-local config or SSH locations are exposed inside a workspace
- **THEN** those paths SHALL be treated as assembled views of attachments rather than the persistence contract itself
