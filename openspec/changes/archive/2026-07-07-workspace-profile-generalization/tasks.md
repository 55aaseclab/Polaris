## 1. Profile Model

- [x] 1.1 Add a workspace profile concept to the Polaris model and config surface
- [x] 1.2 Define Morpheus as the first built-in profile/example
- [x] 1.3 Decide how profile defaults are merged into workspace specs at load time
- [x] 1.4 Keep attachment semantics and backend selection independent from the profile concept

## 2. Backend Generalization

- [x] 2.1 Remove direct Morpheus-name checks from KubeVirt rendering and execution paths
- [x] 2.2 Refactor Docker rendering and lifecycle defaults to consume profile inputs rather than Morpheus-specific assumptions
- [x] 2.3 Remove Morpheus-specific assembly special cases from the pod backend where they are platform behavior rather than profile behavior
- [x] 2.4 Make generated artifact naming derive from workspace/profile inputs rather than fixed Morpheus filenames

## 3. Spec And Example Migration

- [x] 3.1 Update repo-managed specs to express profile selection explicitly
- [x] 3.2 Preserve Morpheus as a reference profile/example rather than a hardcoded backend path
- [x] 3.3 Ensure KubeVirt and Docker examples still work once profile-driven rendering replaces Morpheus-specific logic
- [x] 3.4 Reduce backend-specific assumptions that currently make Polaris feel like a platform for one canonical workspace

## 4. Docs And Verification

- [x] 4.1 Update Polaris docs to explain Morpheus as a built-in profile/example
- [x] 4.2 Add or update tests for profile selection, profile default merging, and backend rendering across profiles
- [x] 4.3 Add or update tests that prove backends no longer depend on the workspace name `morpheus`
- [x] 4.4 Validate profile generalization through typecheck, test suite, and representative render/status flows
