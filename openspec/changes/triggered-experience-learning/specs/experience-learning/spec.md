## ADDED Requirements

### Requirement: Polaris SHALL provide durable workspace and user memory

The system SHALL provide two primary durable memory surfaces:

- workspace memory
- user memory

The workspace memory SHALL store project and environment facts.
The user memory SHALL store durable operator preferences and user-specific
facts.
The workspace memory SHALL have a workspace-local runtime path and a
control-plane mirror.
The user memory SHALL have a user-profile control-plane path and a runtime
path assembled from user identity state.

#### Scenario: Workspace fact is persisted durably

- **WHEN** Polaris learns or is told a durable project or environment fact
- **THEN** it SHALL persist that fact in workspace-scoped memory rather than in
  user-scoped memory

#### Scenario: User preference is persisted durably

- **WHEN** Polaris learns or is told a durable operator preference
- **THEN** it SHALL persist that preference in user-scoped memory rather than
  in workspace-scoped memory

#### Scenario: Memory paths are deterministic

- **WHEN** Polaris prepares durable memory for a workspace session
- **THEN** workspace memory SHALL map to `<workspaceData>/.polaris/MEMORY.md`
- **AND** user memory SHALL map to `<userIdentityState>/polaris/USER.md`
- **AND** the control-plane workspace memory mirror SHALL map to
  `config/users/<user-profile>/polaris/workspaces/<project>/MEMORY.md`
- **AND** the control-plane user memory path SHALL map to
  `config/users/<user-profile>/polaris/USER.md`

### Requirement: Polaris SHALL expose explicit memory operations

The system SHALL support explicit memory operations with at least these
semantics:

- `add`
- `replace`
- `remove`

Each memory operation SHALL carry source attribution and a reason.

#### Scenario: Memory entry is added

- **WHEN** Polaris persists a new durable fact
- **THEN** it SHALL record an `add` operation with source attribution and
  reason

#### Scenario: Memory entry is corrected

- **WHEN** Polaris updates an existing durable fact
- **THEN** it SHALL record a `replace` operation rather than treating the new
  fact as an unrelated append

#### Scenario: Stale memory entry is removed

- **WHEN** Polaris determines that a durable fact should no longer remain in
  memory
- **THEN** it SHALL support a `remove` operation with source attribution and
  reason

### Requirement: Polaris SHALL support memory review and approval policy

The system SHALL support deriving memory updates from meaningful runs through
background review.
The system SHALL also support policy that either:

- writes memory automatically
- stages memory updates for approval before persistence

#### Scenario: Review proposes pending memory update

- **WHEN** a meaningful run yields a candidate durable fact and approval is
  required
- **THEN** Polaris SHALL record a pending memory update rather than writing it
  immediately

#### Scenario: Approved memory update is persisted

- **WHEN** an operator approves a pending memory update
- **THEN** Polaris SHALL apply the update to the correct durable memory
  surface

#### Scenario: Pending memory update uses structured record shape

- **WHEN** Polaris stages a memory update for approval
- **THEN** it SHALL persist a structured record containing target, operation,
  stable key, reason, source attribution, proposal timestamp, and status

### Requirement: Polaris SHALL assemble frozen session memory snapshots

The system SHALL assemble memory into a session snapshot at session start.
Memory writes that occur during the session MAY update durable state
immediately, but they SHALL NOT require continuous prompt mutation in the
current session.

#### Scenario: Session sees start-of-session memory snapshot

- **WHEN** a new agent session starts
- **THEN** Polaris SHALL assemble workspace and user memory into a session
  snapshot for that session

#### Scenario: In-session memory write is deferred for next snapshot

- **WHEN** Polaris persists memory during an active session
- **THEN** the durable memory SHALL update, and the new memory SHALL become
  available to later snapshots without requiring continuous prompt mutation in
  the current session

#### Scenario: Session snapshot has stable source format

- **WHEN** Polaris assembles a session memory snapshot
- **THEN** it SHALL render a manager-neutral markdown document containing
  header metadata, workspace memory, user memory, and provider memory sections

### Requirement: Polaris SHALL support optional external memory providers

The system SHALL allow optional external memory providers that can enrich local
memory retrieval and sync.
Local durable memory surfaces SHALL remain authoritative unless policy says
otherwise.

#### Scenario: Provider enriches pre-run retrieval

- **WHEN** a memory provider is enabled for a session
- **THEN** Polaris MAY retrieve relevant external memories before assembling the
  session snapshot

#### Scenario: Approved local memory is synced externally

- **WHEN** Polaris persists an approved durable memory update and provider sync
  is enabled
- **THEN** it MAY mirror that memory update to the external provider
