## ADDED Requirements

### Requirement: Polaris SHALL support explicit lesson-learning trigger markers
The system SHALL recognize explicit lesson-learning trigger markers in real agent-run context. The initial trigger vocabulary SHALL include `POLARIS-LEARN-IT`, `POLARIS-RECALL`, `POLARIS-DONT-LEARN`, and `POLARIS-EPHEMERAL`.

#### Scenario: Explicit learn trigger marks a run for persistence
- **WHEN** a user issues a run that contains `POLARIS-LEARN-IT`
- **THEN** Polaris SHALL treat the run as a candidate for durable lesson summarization and storage

#### Scenario: Explicit recall trigger requests prior lessons
- **WHEN** a user issues a run that contains `POLARIS-RECALL`
- **THEN** Polaris SHALL retrieve and inject relevant prior lessons for that run

#### Scenario: Explicit do-not-learn trigger suppresses persistence
- **WHEN** a run contains `POLARIS-DONT-LEARN`
- **THEN** Polaris SHALL NOT persist a new durable lesson from that run unless the operator overrides the suppression explicitly

### Requirement: Polaris SHALL persist lessons as structured summaries rather than skills
The system SHALL store durable learning artifacts as structured lessons with title, summary, usage guidance, retrieval tags, source metadata, confidence, and scope. The system SHALL NOT treat those artifacts as autonomous skills in this capability.

#### Scenario: Structured lesson is stored for a meaningful run
- **WHEN** Polaris persists a lesson from an explicitly marked or meaningful run
- **THEN** the stored artifact SHALL include a concise summary, when-to-use guidance, tags, source session metadata, and confidence

#### Scenario: Skill creation remains out of scope
- **WHEN** Polaris persists an experience-derived artifact in this capability
- **THEN** it SHALL store a lesson record and SHALL NOT create or promote an autonomous skill definition

### Requirement: Polaris SHALL use selective summarization for lesson distillation
The system SHALL use model-based lesson distillation only for selected runs, including explicit learn-triggered runs and meaningful success or failure events. Routine runs without an explicit trigger or notable outcome SHALL NOT require model summarization.

#### Scenario: Triggered run uses cheap summarizer
- **WHEN** a run includes `POLARIS-LEARN-IT`
- **THEN** Polaris SHALL be allowed to invoke a cheap coding-capable summarizer model to distill a lesson from the captured experience

#### Scenario: Routine run avoids unnecessary summarization cost
- **WHEN** a run has no explicit learning trigger and no meaningful success or failure to distill
- **THEN** Polaris SHALL NOT invoke lesson summarization for that run
