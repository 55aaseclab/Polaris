## Context

Polaris already has a user-scoped credential registry and a workspace runtime
assembly model, but the current UX and runtime logic are Codex-centric. The web
portal only exposes a narrow Codex credential form, the Paseo status page still
reflects older workspace-override assumptions, and there is no clean way to
switch the live `.codex` material used by a running workspace without coupling
that action to driver switching or daemon management.

At the same time, `cc-switch` already encodes useful Codex-specific knowledge:
provider presets, default template generation, and the distinction between
stored provider material and live `.codex` file writes. Polaris should reuse
that knowledge where it helps, but Polaris should keep its own source of truth
for user credentials and avoid pulling in `cc-switch`'s Tauri, SQLite, and
proxy-takeover architecture.

## Goals / Non-Goals

**Goals:**

- Make user credential management harness-aware across SSH, Codex, Claude,
  Copilot, OpenCode, and pi.
- Reshape the credentials page into grouped sections with add/delete actions.
- Reuse Codex preset/template data from `cc-switch` for credential creation.
- Add a live workspace Codex-family credential switch that updates runtime
  `.codex` material independently of driver and Paseo lifecycle.
- Expose enough workspace status metadata for the portal to render harness and
  live credential selection cleanly.

**Non-Goals:**

- Rebuild `cc-switch`'s full provider manager, local proxy, or takeover model
  inside Polaris.
- Generalize live switching for every harness in the first pass. The first live
  switch path targets Codex-compatible material under `.codex`.
- Change the daemon/driver lifecycle model as part of credential management.
- Introduce a new database; Polaris remains file-backed for this feature.

## Decisions

### Keep Polaris credential registry as SSOT

Polaris will keep `config/users/<user>/credentials/*.yaml` plus generated
material files as its system of record. This avoids forcing the Polaris
control-plane into `cc-switch`'s provider DB model and keeps user/workspace
ownership aligned with existing Polaris file layouts.

Alternative considered:
- Embed `cc-switch`'s provider storage directly.
  Rejected because it would import unrelated state, lifecycle, and migration
  complexity just to manage a narrower Polaris credential domain.

### Reuse `cc-switch` data and Codex file semantics, not its full app

Polaris will snapshot Codex provider template data from `cc-switch` and record
the source commit in repo code or docs. For live switching, Polaris will mirror
the useful `cc-switch` semantic split:
- stored credential material remains user-scoped
- live workspace switching rewrites runtime `.codex` files

Alternative considered:
- Vendor large `cc-switch` runtime modules wholesale.
  Rejected because the Tauri/proxy/takeover layers are not needed and would
  create a high-cost merge surface.

### Split control-plane management from live workspace switching

The credentials page will manage creation and deletion of user-scoped
credentials only. The Paseo status page will offer live selection for the
currently running workspace. This preserves the separation you called out:
credential management is not the same concern as driver or daemon management.

Alternative considered:
- Drive all credential switching through the credentials page.
  Rejected because the page manages user inventory, not the active runtime
  attachment for one workspace.

### Implement live switch through driver-aware runtime mutation

Polaris will implement a workspace credential switch path that writes the
selected Codex-family credential material into the active runtime identity
mount. The mutation path will stay driver-aware:
- docker: `docker exec`
- pod: `kubectl exec`
- kubevirt-vm: guest exec/ssh path

The first version only updates `.codex` material. Other harnesses can be added
later once their live file layouts are formalized.

Alternative considered:
- Treat credential switching as a full workspace restart.
  Rejected because the requested behavior is a live switch and the running
  workspace already owns a mutable identity mount.

## Risks / Trade-offs

- [Drift between Polaris and `cc-switch` presets] → Record the upstream commit
  and keep the imported Codex preset layer small and explicit.
- [Driver-specific live writes are easy to get wrong] → Implement the switch
  behind one executor/API path with focused driver tests.
- [Non-Codex harnesses remain partially managed at first] → Make the first-pass
  UI explicit about available live switch support and keep unsupported actions
  disabled rather than implicit.
- [Runtime writes can race with user activity] → Limit first-pass live switch to
  replacing `.codex` credential files in the durable identity mount, without
  mutating driver or daemon process state.

## Migration Plan

- No persistent data migration is required for existing SSH and Codex
  credentials.
- Add harness metadata expansion in a backward-compatible way so existing
  credential documents still load.
- Introduce Codex preset snapshot files and use them for new credential creation
  only.
- Rollback is file-based: remove the new UI/API paths and keep existing
  credential registry files intact.

## Open Questions

- Whether Polaris should keep the imported `cc-switch` preset snapshot as raw
  JSON/TS data or normalize it into a smaller Polaris-native schema.
- Whether Claude/Copilot/OpenCode/pi need live switch semantics in the same
  release or only inventory management first.
