## Context

Polaris has grown into a real workspace platform: it has a control plane, backend abstractions, direct attachment-based persistence config, and a runtime-controller pipeline. But a large amount of backend realization still assumes one canonical workspace shape: Morpheus.

Today this shows up in several ways:

- KubeVirt rendering still explicitly rejects non-`morpheus` workspaces.
- KubeVirt generated assets are tied to names like `morpheus.yaml` and `morpheus-vm-cloudinit-secret.yaml`.
- Docker rendering assumes a Morpheus-shaped service/container/bootstrap profile.
- Pod rendering still carries a Morpheus-specific runtime assembly special case.

The problem is no longer the control-plane architecture. The problem is that backend realization is still profile-implicit and Morpheus-specific rather than profile-explicit and reusable.

## Goals / Non-Goals

**Goals:**

- Make workspace profiles explicit in the Polaris model.
- Keep Morpheus as a built-in profile/example rather than removing it.
- Remove project-name-specific branching from backend implementations.
- Let backend rendering derive defaults from profile inputs instead of hardcoded Morpheus assumptions.
- Generalize generated artifact naming and backend templates so they are not tied to one workspace name.

**Non-Goals:**

- Removing Morpheus as a supported profile.
- Redesigning the attachment model again.
- Building a full multi-profile marketplace or registry in this change.
- Eliminating all existing example/generated assets immediately if they are still useful as migration references.

## Decisions

### Decision: Morpheus remains a built-in profile, not a backend special case

Morpheus will stay as a first-class built-in profile/example, but backend code will no longer use the workspace identity `morpheus` as a trigger for special behavior.

Rationale:

- Morpheus is useful as a canonical profile and example.
- The problem is not the existence of Morpheus; the problem is backend code depending on its name directly.

Alternatives considered:

- Remove Morpheus entirely from the platform surface. Rejected because a built-in reference profile is valuable.

### Decision: Profiles provide reusable backend defaults

Workspace profiles should provide reusable defaults for:

- base image
- service defaults
- bootstrap behavior
- optional tooling defaults
- generated artifact naming inputs

Rationale:

- These are exactly the concerns currently leaking through Morpheus-specific assumptions.
- Making them profile-driven separates “workspace personality” from “backend implementation.”

Alternatives considered:

- Keep these values embedded directly in each backend renderer. Rejected because it preserves duplication and hardcoded assumptions.

### Decision: Backend renderers consume profile inputs, not workspace-name checks

Backend renderers should be parameterized by profile data and workspace spec data, not by ad hoc tests against `workspace.identity.projectName`.

Rationale:

- This is the clean platform boundary.
- It makes KubeVirt and Docker finally feel like backend implementations rather than Morpheus wrappers.

Alternatives considered:

- Replace a `morpheus` name check with a small list of special names. Rejected because it scales the wrong pattern.

### Decision: Generated artifact naming becomes profile-/workspace-driven

Generated artifacts should derive their names from profile and workspace inputs rather than being fixed to Morpheus-specific filenames.

Rationale:

- This is required to make non-Morpheus workspaces first-class.
- It also improves debugging by making generated assets line up with the requested workspace shape.

Alternatives considered:

- Keep one set of Morpheus-named generated assets and reinterpret them generically. Rejected because it keeps the platform semantics muddy.

### Decision: Pod, KubeVirt, and Docker must all honor the same profile concept

Profiles should not be a KubeVirt-only or Docker-only abstraction. All backends should consume the same profile concept even if they realize it differently.

Rationale:

- Otherwise the same workspace identity problem will reappear backend by backend.
- It keeps Polaris coherent as a workspace platform.

Alternatives considered:

- Only generalize the backends that are currently Morpheus-heavy. Rejected because pod already contains Morpheus-specific assembly behavior too.

## Risks / Trade-offs

- [Introducing profiles may add another layer to the config model] → Mitigation: keep the first version small, with Morpheus as the built-in reference profile and a straightforward profile data shape.
- [Migration may touch many generated artifacts and docs at once] → Mitigation: keep profile introduction focused on backend realization and naming, not on unrelated platform redesign.
- [Some current tests assume Morpheus directly] → Mitigation: preserve Morpheus as a profile so existing expectations can migrate gradually.
- [Profiles could become a dumping ground for backend-specific hacks] → Mitigation: keep profiles about defaults and identity, while backend-specific implementation remains in backend code.

## Migration Plan

1. Add a workspace profile concept to the control-plane model and config.
2. Define Morpheus as the initial built-in profile.
3. Refactor backend renderers to consume profile inputs and remove direct Morpheus-name checks.
4. Generalize generated asset naming and path selection accordingly.
5. Update tests and docs so they describe Morpheus as a built-in profile/example, not as a hardcoded backend path.
6. Later, add more reusable profiles once the first profile boundary is stable.

## Open Questions

- What is the cleanest direct config shape for selecting and extending a profile?
- Should profile defaults be merged at load time into the workspace spec, or carried explicitly deeper into backend rendering?
- Which generated assets should stay committed as examples, and which should become fully derived outputs?
