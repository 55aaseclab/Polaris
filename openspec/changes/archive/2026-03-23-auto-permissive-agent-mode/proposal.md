## Why

The repository promises Kata-isolated agent containers that can run in permissive mode without constant approval prompts, but the generator currently applies that behavior inconsistently. Codex is launched permissively by default while Claude Code still requires an interactive opt-in, which creates friction and makes the documented workflow misleading.

## What Changes

- Add a generator-level permissive mode policy prompt, defaulting to enabled for supported agents created with `scripts/new-agent.sh`.
- Apply permissive-mode startup flags automatically for both Claude Code and Codex when that policy is enabled.
- Preserve a user-controlled way to disable permissive mode during generation for stricter or debugging-oriented containers.
- Update vault documentation so the described default behavior matches the generated agent manifests and launch commands.

## Capabilities

### New Capabilities
- `agent-permissive-mode`: Defines how generated agent containers default, persist, and launch with permissive mode across supported agent CLIs.

### Modified Capabilities

## Impact

- Affects `scripts/new-agent.sh` agent selection and launch configuration flow.
- Changes generated `.env` metadata and tmux launch behavior for Claude Code containers.
- Requires documentation updates in repo README files that describe agent defaults and permissive mode expectations.
