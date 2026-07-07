## 1. Config and Model

- [x] 1.1 Add a first-class `Credential` config model with canonical fields
  for `id`, `userId`, `kind`, `label`, `purposes`, `materialRef`, `metadata`,
  and `status`.
- [x] 1.2 Add file-backed registry discovery for
  `config/users/credentials/<user>/*.yaml` and keep `UserProfile` loading
  focused on user identity and defaults.
- [x] 1.3 Extend saved workspace config to declare explicit credential
  bindings by `purpose`, `credentialId`, and `required` separately from driver
  selection.

## 2. Registry Loading and Validation

- [x] 2.1 Implement credential registry parsing and required-field validation
  for each user-owned credential document.
- [x] 2.2 Validate credential ownership, kind support, and `materialRef`
  structure before a credential becomes available to orchestration.
- [x] 2.3 Reject registry entries that inline secret material instead of
  externalizing it through `materialRef`.

## 3. Workspace Binding Resolution

- [x] 3.1 Implement workspace binding resolution that maps each binding
  purpose to a referenced user-owned credential.
- [x] 3.2 Enforce that direct workspace credential bindings take precedence
  over legacy auth-related profile or workspace fields.
- [x] 3.3 Reject invalid bindings, including cross-user references and missing
  required credentials, before workspace realization.

## 4. Runtime Assembly and Attachment Mapping

- [x] 4.1 Update runtime assembly to derive SSH, Codex, and token auth inputs
  from resolved workspace credential bindings first.
- [x] 4.2 Map credential kinds onto existing attachment classes, including
  `ssh-key` to `user-ssh-state` and `codex-auth` to `user-identity-state`.
- [x] 4.3 Preserve per-workspace runtime status while keeping credential
  material user-scoped and reusable across workspaces.

## 5. Compatibility and Migration

- [x] 5.1 Add a bounded compatibility path that derives temporary credential
  views from legacy `UserProfile` auth fields when explicit bindings are
  absent.
- [x] 5.2 Update config save and normalization flows so newly written
  workspace intent uses explicit credential bindings by default.
- [x] 5.3 Document and enforce migration precedence so explicit bindings
  remain authoritative during the transition period.

## 6. Tests and Documentation

- [x] 6.1 Add parser and validation tests for credential registry entries,
  supported kinds, and secret-externalization rules.
- [x] 6.2 Add orchestration and runtime tests for binding precedence,
  attachment mapping, and invalid binding rejection.
- [x] 6.3 Update operator and developer documentation for the credential
  registry layout, workspace binding model, and migration from inline profile
  auth.
