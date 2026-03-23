## 1. Generator policy flow

- [x] 1.1 Add a single permissive-mode prompt to `scripts/new-agent.sh`, defaulting to enabled for supported agents.
- [x] 1.2 Refactor agent selection logic so permissive mode is translated into the correct Claude Code or Codex startup flag from a central decision path.
- [x] 1.3 Preserve the ability to generate supported agent containers without permissive flags when the user disables the policy.

## 2. Generated metadata and launch behavior

- [x] 2.1 Write the permissive-mode setting into the generated project `.env` file alongside the resolved agent command and arguments.
- [x] 2.2 Ensure deploy and attach flows continue to launch tmux with the resolved agent arguments captured during generation.
- [x] 2.3 Validate the generated summary output clearly reflects the selected permissive-mode behavior.

## 3. Documentation and verification

- [x] 3.1 Update the README files that describe Kata-backed agent defaults so they document generator-level permissive mode and agent-specific flag mapping.
- [x] 3.2 Run `bash -n scripts/new-agent.sh` to verify shell syntax after the generator changes.
- [x] 3.3 Perform a targeted manual generation check for Claude Code and Codex flows, or document any sandbox limitations if execution is not possible.
