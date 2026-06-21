## 1. User Profile Model

- [x] 1.1 Add a first-class user profile type to the Polaris workspace model
- [x] 1.2 Define the initial user profile fields for name, email, and SSH mode
- [x] 1.3 Add workspace-level selection of a user profile separate from workspace profile
- [x] 1.4 Add a bounded compatibility path for existing workspace specs that still declare Git identity inline

## 2. Config And Resolution

- [x] 2.1 Define where repo-managed user profile data lives and how it is loaded
- [x] 2.2 Update workspace config loading so a workspace resolves both workspace profile and user profile
- [x] 2.3 Reject invalid user-profile references and missing required user-profile identity inputs early
- [x] 2.4 Update scaffolded Docker specs to reference an explicit user profile

## 3. Identity Realization

- [x] 3.1 Move Git bootstrap defaults to consume the selected user profile
- [x] 3.2 Move SSH key comment and SSH key source policy to the selected user profile
- [x] 3.3 Support both managed-key and provided-key SSH modes in backend bootstrap logic
- [x] 3.4 Update backend naming for user-scoped identity storage to derive from explicit user profile identity rather than runtime UNIX user alone

## 4. Attachment And Runtime Semantics

- [x] 4.1 Ensure user-scoped attachment ownership and reuse are defined in terms of the selected user profile
- [x] 4.2 Tighten backend parity so Docker, pod, and KubeVirt preserve the same user-scoped identity semantics
- [x] 4.3 Update runtime status and drift reporting so user-profile-derived identity state is visible and diagnosable

## 5. Docs And Verification

- [x] 5.1 Update Polaris docs to explain workspace profile versus user profile responsibilities
- [x] 5.2 Add or update tests for user profile resolution, Git identity derivation, and SSH mode behavior
- [x] 5.3 Add backend-focused tests for user-scoped identity naming and cross-workspace reuse behavior
- [x] 5.4 Validate the change with typecheck, Polaris tests, and representative pod, Docker, and KubeVirt flows
