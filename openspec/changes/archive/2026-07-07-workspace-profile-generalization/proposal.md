## Why

Polaris now has a real control plane, direct attachment config, and three named backends, but the backend implementations are still too tightly coupled to one canonical workspace shape: Morpheus. That makes Polaris feel like a platform wrapped around one built-in workspace instead of a reusable workspace platform with Morpheus as a default profile.

## What Changes

- Introduce explicit workspace profile semantics so backend rendering and runtime defaults are profile-driven rather than project-name-driven.
- Keep `morpheus` as a built-in profile/example, but remove Morpheus-specific assumptions from backend implementations.
- Move fixed backend defaults such as image selection, bootstrap assumptions, service exposure defaults, and generated artifact naming behind reusable profile inputs.
- **BREAKING** Stop treating the workspace name `morpheus` as a special backend implementation trigger.
- Generalize KubeVirt and Docker render flows so they no longer require Morpheus-specific filenames or project-name checks.
- Make the pod backend stop using Morpheus-specific runtime-assembly special cases as platform behavior.

## Capabilities

### New Capabilities
- `workspace-profiles`: Reusable workspace profiles that provide backend defaults, tooling defaults, and service defaults without hardcoding one workspace name into backend implementations.

### Modified Capabilities
- `workspace-orchestration`: Workspace identity and backend realization are decoupled from Morpheus-specific assumptions and become profile-driven.
- `workspace-backend-parity`: First-class backends must consume reusable profile inputs rather than one canonical Morpheus-shaped realization path.

## Impact

- Primary impact on `scripts/polaris/backends/**`, especially pod, kubevirt, and docker render paths.
- Spec and config impact on `config/specs/**`, because workspace intent will need a profile layer or profile reference.
- Documentation impact on `docs/polaris/README.md`, `docs/polaris/runtime-layout.md`, and operations/tooling references.
- Test impact across backend rendering, generated artifact naming, and default workspace behavior.
