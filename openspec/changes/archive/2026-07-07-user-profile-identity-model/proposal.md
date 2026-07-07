## Why

Polaris already models `user-identity-state` and `user-ssh-state` as
cross-workspace, user-scoped attachments, but it still spreads actual user
identity across workspace-local `tooling` fields, generated SSH behavior, and
 backend-specific assumptions. That makes Git identity, SSH identity, and agent
 identity inconsistent today and will become a real problem once Polaris needs
 to support multiple users cleanly.

## What Changes

- Introduce an explicit user profile model that owns at least user name and
  email.
- Make workspaces select a user profile separately from the workspace profile.
- Move Git identity defaults (`git_user_name`, `git_user_email`) out of
  per-workspace `tooling` fields and behind the selected user profile.
- Move SSH identity policy behind the user profile so SSH key comment and SSH
  state ownership are no longer derived from the workspace profile or runtime
  UNIX user alone.
- Define user-profile ownership of external agent identity state for Codex and
  Claude so user-scoped attachments have a concrete owner.
- **BREAKING** Stop treating workspace specs as the primary place where user
  identity is declared.
- **BREAKING** Stop deriving durable user identity naming solely from runtime
  user strings such as `root`.

## Capabilities

### New Capabilities
- `user-profiles`: First-class user profiles that own Git identity, SSH
  identity policy, and user-scoped external agent identity defaults.

### Modified Capabilities
- `workspace-orchestration`: Workspace intent must reference a user profile in
  addition to backend and workspace profile information.
- `workspace-attachments`: User-scoped durable attachments must be owned by an
  explicit user profile rather than only by implicit runtime conventions.
- `workspace-attachment-lifecycle`: Cross-workspace identity and SSH reuse must
  be defined in terms of a selected user profile.
- `workspace-runtime-contract`: Runtime-visible Git and SSH identity assembly
  must be derived from the selected user profile.

## Impact

- Primary impact on `scripts/polaris/core/workspace.ts`,
  `scripts/polaris/config/load.ts`, and backend render/bootstrap behavior in
  `scripts/polaris/backends/**`.
- Config and spec impact on `config/specs/**`, because workspace intent will
  need to reference a user profile and user profile data will need a home.
- Identity and persistence impact on Docker volume naming, SSH key generation
  or import policy, and Git bootstrap behavior.
- Documentation impact on `docs/polaris/README.md`,
  `docs/polaris/runtime-layout.md`, and any onboarding guidance that currently
  assumes a single operator identity.
- Test impact across config loading, bootstrap behavior, attachment semantics,
  and multi-workspace identity reuse.
