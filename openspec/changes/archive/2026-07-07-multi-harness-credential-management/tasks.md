## 1. Credential model and templates

- [x] 1.1 Expand the managed credential model and CLI parsing to support `ssh`, `codex`, `claude`, `copilot`, `opencode`, and `pi`
- [x] 1.2 Add a Polaris-owned Codex preset/template catalog snapshot derived from `cc-switch` and use it for Codex credential creation defaults
- [x] 1.3 Keep profile-required SSH credential creation on the credential layer and remove any implicit non-SSH default credential creation

## 2. Portal credential APIs

- [x] 2.1 Replace the Codex-only portal credential create flow with harness-aware create/list/delete endpoints
- [x] 2.2 Expose credential metadata needed by the UI, including harness family, provider fields, and live-switch eligibility

## 3. Runtime live credential switching

- [x] 3.1 Extend workspace status synthesis to expose supported harnesses and the current live credential selection state
- [x] 3.2 Add an executor-backed live credential switch operation for running docker and pod workspaces that rewrites runtime `.codex` material without changing driver or daemon lifecycle
- [x] 3.3 Expose the live credential switch through portal and executor HTTP endpoints

## 4. Credential management UI

- [x] 4.1 Rework the profile credentials page into grouped harness sections with table rows, add actions, and row-level delete actions
- [x] 4.2 Add Codex create forms backed by reusable provider templates and placeholders for Claude, Copilot, OpenCode, and pi inventory management

## 5. Paseo status UI

- [x] 5.1 Replace the disabled workspace credential control with a dedicated credential selection area that filters credentials by harness
- [x] 5.2 Wire the live switch action for supported harnesses and keep unsupported harnesses visibly unavailable

## 6. Verification

- [x] 6.1 Add or update backend tests for credential creation, deletion, and live switch flows
- [x] 6.2 Add or update portal tests and run the relevant build/test commands
