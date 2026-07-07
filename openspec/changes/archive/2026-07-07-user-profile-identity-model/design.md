## Context

Polaris already has a strong distinction between workspace-scoped and
user-scoped attachments, but it does not have a first-class user object.
Instead, user identity is spread across:

- per-workspace Git fields in `tooling`
- generated or imported SSH state under `user-ssh-state`
- external agent identity files under `user-identity-state`
- backend-specific naming conventions such as Docker volume names derived from
  runtime UNIX user strings
- workspace-profile defaults such as SSH key comment

That model is acceptable for a single-operator system but inconsistent once the
platform needs explicit ownership of user-scoped state or future multi-user
support. The current state also makes it hard to reason about private Git
access because “a key exists” and “that key belongs to an explicit user
identity” are not the same thing.

## Goals / Non-Goals

**Goals:**

- Introduce an explicit user profile model that owns Git identity, SSH identity
  policy, and user-scoped external agent identity defaults.
- Make workspace intent reference a user profile separately from the workspace
  profile.
- Align runtime assembly and durable attachment naming with explicit user
  identity rather than with implicit runtime-user conventions.
- Preserve the existing Polaris split:
  workspace profile answers “what kind of workspace is this?”
  user profile answers “who owns the identity?”
- Keep the first iteration small enough to support current single-user flows
  while making future multi-user support possible.

**Non-Goals:**

- Implement full multi-user authorization, tenancy, or access control.
- Add forge-specific APIs for registering public SSH keys automatically.
- Replace external Codex or Claude authentication systems with Polaris-native
  identity providers.
- Solve every future identity concern such as signing keys, multiple forges, or
  organization policy in the first iteration.

## Decisions

### Decision: Add a first-class `user profile` layer separate from workspace profile

Polaris should model user identity explicitly rather than continuing to spread
 it across workspace specs and backend-specific bootstrap behavior.

Rationale:

- It matches the existing `user-identity-state` and `user-ssh-state`
  attachment semantics.
- It gives Git identity, SSH identity, and external agent identity a single
  owner.
- It creates a clean boundary for later multi-user support.

Alternatives considered:

- Keep `git_user_name` and `git_user_email` inside each workspace spec.
  Rejected because it duplicates user identity and leaves SSH/agent identity
  disconnected.
- Extend workspace profile to own user identity concerns.
  Rejected because workspace profile describes reusable workspace defaults, not
  the human or operator identity using them.

### Decision: The minimum user profile SHALL own name, email, and SSH policy

The first iteration should not stop at `name` and `email`. It should also own
SSH identity policy, because SSH behavior is one of the current inconsistencies
that user profiles are meant to solve.

Rationale:

- Git name and email alone do not solve the current identity-model mismatch.
- SSH key comment, SSH key source policy, and user-scoped SSH naming are
  identity concerns, not workspace concerns.

Alternatives considered:

- Limit the first iteration to `name` and `email`.
  Rejected because it creates a shallow abstraction while leaving the most
  important identity behavior elsewhere.

### Decision: Support both managed-key and provided-key SSH modes

User profiles should support at least two SSH modes:

- `managed-key`: Polaris generates and persists a key if absent.
- `provided-key`: Polaris expects a staged SSH private key and MUST NOT
  generate one automatically.

Rationale:

- Managed keys preserve the current smooth bootstrap path.
- Provided keys support users who need deterministic identity for private Git.
- This matches the external-agent philosophy: Polaris manages workspace
  assembly, while users choose how identity material enters the system.

Alternatives considered:

- Managed-key only.
  Rejected because a generated key is not automatically usable for private
  repositories.
- Provided-key only.
  Rejected because it makes first-run local onboarding much heavier.

### Decision: User-scoped attachment naming should derive from user profile identity

Where backends need persistent naming for user-scoped identity, they should key
that naming from the selected user profile id rather than from runtime UNIX
user alone.

Rationale:

- Runtime user `root` is not a real user identity.
- Docker volume names such as `polaris-root-ssh` are not a stable user model.
- Explicit user-derived naming aligns better with the declared
  cross-workspace semantics.

Alternatives considered:

- Continue to derive naming from runtime user strings.
  Rejected because it breaks down immediately once multiple Polaris users share
  the same runtime user.

### Decision: Workspace specs should reference a user profile, not inline a full user definition by default

Workspace intent should select a user profile identifier. User profile data
should live in a separate config surface rather than being duplicated inline in
every workspace spec.

Rationale:

- It keeps user identity reusable across workspaces.
- It avoids per-workspace duplication.
- It matches the existing architectural direction where workspace specs select
  reusable profiles and backend inputs.

Alternatives considered:

- Inline full user profile blocks inside every workspace spec.
  Rejected because it turns user identity into another repeated workspace-local
  blob.

## Risks / Trade-offs

- [A user profile introduces a second profile axis] → Keep the distinction
  explicit in docs and config: workspace profile is workspace intent; user
  profile is identity ownership.
- [SSH mode adds more configuration surface] → Start with only two clearly
  defined modes and avoid forge-specific complexity.
- [Migration could be noisy because Git identity already exists in many specs]
  → Provide a compatibility path that can derive a temporary user profile from
  current workspace-local fields during migration.
- [Backends differ today in how faithfully they realize user-scoped state] →
  Use this design to tighten backend parity instead of allowing another
  backend-specific identity fork.

## Migration Plan

1. Add user profile config and workspace references without removing the
   existing workspace-local Git fields immediately.
2. Teach the loader to resolve the selected user profile and derive identity
   defaults from it.
3. Add a bounded compatibility path for existing specs that still declare
   `git_user_name` and `git_user_email` inline.
4. Move SSH comment, SSH mode, and user-scoped naming to the user profile.
5. Update Docker, pod, and KubeVirt bootstrap/render behavior to consume user
   profile inputs.
6. Migrate repo-managed specs to select a user profile explicitly.
7. Remove workspace-local identity declarations once the migration path is
   complete.

## Open Questions

- What should the initial on-disk user profile registry look like?
- Should Codex and Claude identity selection be separate named profiles under a
  user, or should the first iteration assume one default external-agent
  identity bundle per user?
- Should Polaris expose an operator-facing command to print a managed SSH public
  key for registration with GitHub or GitLab?
