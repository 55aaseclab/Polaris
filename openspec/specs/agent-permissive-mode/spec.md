## ADDED Requirements

### Requirement: Generator-level permissive mode policy
The agent generator SHALL ask for permissive mode once per container configuration flow, default the choice to enabled, and apply that policy consistently to supported agent CLIs.

#### Scenario: Default permissive mode accepted
- **WHEN** a user selects Claude Code or OpenAI Codex and accepts the default permissive-mode choice
- **THEN** the generator SHALL mark permissive mode as enabled for the generated container
- **AND** the generator SHALL resolve the corresponding permissive startup flag for the selected agent

#### Scenario: Permissive mode disabled
- **WHEN** a user selects a supported agent and explicitly disables permissive mode
- **THEN** the generator SHALL preserve that choice in the generated container configuration
- **AND** the generator SHALL not add a permissive startup flag to the agent launch command

### Requirement: Agent-specific permissive flag mapping
The generator SHALL translate the permissive-mode policy into the correct startup arguments for each supported agent CLI.

#### Scenario: Claude Code permissive launch
- **WHEN** Claude Code is selected and permissive mode is enabled
- **THEN** the generated launch configuration SHALL include `--dangerously-skip-permissions`

#### Scenario: Codex permissive launch
- **WHEN** OpenAI Codex is selected and permissive mode is enabled
- **THEN** the generated launch configuration SHALL include `--dangerously-bypass-approvals-and-sandbox`

### Requirement: Generated artifacts reflect permissive policy
The generated project artifacts SHALL record the resolved permissive-mode setting and use it consistently in subsequent deploy and attach flows.

#### Scenario: Generated metadata records policy
- **WHEN** the generator writes the project `.env` file
- **THEN** the file SHALL include whether permissive mode is enabled for the project
- **AND** the stored launch arguments SHALL match that policy for the selected agent

#### Scenario: Attach flow uses resolved launch behavior
- **WHEN** the generator deploys or re-attaches to a generated project
- **THEN** the tmux launch command SHALL use the same resolved agent arguments captured during generation

### Requirement: Documentation matches default behavior
Repository documentation SHALL describe permissive mode as a generator-level default for supported agent containers and explain how it can be disabled.

#### Scenario: Agent defaults documented
- **WHEN** a user reads the repository setup documentation for Kata-backed agent containers
- **THEN** the documentation SHALL state that supported agents default to permissive mode in generated containers
- **AND** the documentation SHALL identify Claude Code and Codex as using different underlying CLI flags
