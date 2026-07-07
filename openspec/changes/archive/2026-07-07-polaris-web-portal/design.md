## Context

Polaris already owns workspace config, driver selection, status synthesis,
credential binding, and runtime state. The new portal should expose that control
plane through a web UI without duplicating the model or creating a second
source of truth. Clerk will handle user authentication, while Polaris remains
the workspace authority.

## Goals / Non-Goals

**Goals:**
- Add a user-based web portal inside `apps/polaris`.
- Authenticate via Clerk and authorize access by explicit user route.
- Support self-service credential management for user-owned credentials.
- Support workspace listing, status, provisioning progress, and driver
  switching.
- Keep the directory tree and Polaris state files as the source of truth.

**Non-Goals:**
- Replace Polaris CLI workflows.
- Introduce a second workspace registry.
- Add a separate standalone portal application.
- Redesign backend runtime behavior beyond what the portal needs to expose.

## Decisions

- Put the portal in `apps/polaris` rather than a separate app. The control-plane
  logic already lives there, so a portal elsewhere would duplicate ownership,
  status, and switching rules.
- Treat `/users/<user_id>/workspaces/<workspace_name>` as the canonical portal
  route. This matches the new user-explicit workspace identity model and makes
  authorization visible in the URL.
- Use Clerk only for identity/session authentication. Polaris remains the source
  of workspace ownership, credentials, and backend selection.
- Resolve ownership from `config/users/<user_id>/projects/<workspace_name>/`,
  not from profile `workspaces:` lists. The profile list remains a derived index
  that can be regenerated.
- Keep driver profiles flat in the portal as `docker`, `pod:gvisor`,
  `pod:data-container`, and `kubevirt-vm`. Pod profiles remain profiles under
  the `pod` backend kind.
- Make workspace creation a blocking provisioning workflow that can report
  progress while the user leaves and returns later.

## Risks / Trade-offs

- [Risk] Portal and CLI could drift if they each grow separate control paths →
  Mitigation: refactor the shared workspace and driver operations into common
  services.
- [Risk] Clerk user identity may not map cleanly to existing Polaris user ids →
  Mitigation: keep a stable internal user id mapping layer and treat Clerk as an
  upstream identity provider.
- [Risk] Blocking provisioning can be slow for image builds →
  Mitigation: persist progress and make the UI resumable.
- [Risk] Route-based user ids can tempt hard-coded assumptions about ownership →
  Mitigation: keep ownership checks in the control plane and reject cross-user
  access unless the session is admin-scoped.
