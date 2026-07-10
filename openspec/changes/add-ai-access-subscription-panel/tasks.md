## 1. Provider Facts And Portal API

- [x] 1.1 Define a normalized AI Access facts model and capability model for
  provider adapters in the portal/service layer.
- [x] 1.2 Implement the first provider adapter path for the current backend,
  mapping provisioning, funding, referral, and health facts into the normalized
  model.
- [x] 1.3 Add portal service aggregation that derives the user-facing AI Access
  states (`not_provisioned`, `funding_needed`, `ready`, `error`) and allowed
  actions from provider facts plus runtime readiness.
- [x] 1.4 Add portal server endpoints for reading a user's AI Access view model
  and invoking supported actions such as provision, top up entry, refresh, and
  retry.

## 2. Automatic Setup And Diagnostics

- [x] 2.1 Implement background reconciliation that automatically ensures any
  required runtime setup after provisioning or funding changes.
- [x] 2.2 Detect and surface failed automatic setup as an `error` state instead
  of a normal setup-pending product state.
- [x] 2.3 Expose advanced diagnostics fields for provider backend identity,
  linkage state, setup status, and recent integration errors without promoting
  them into the primary UX.

## 3. Admin Pane UI

- [x] 3.1 Add an `AI Access` tab to the selected-user admin pane and adjust the
  tab navigation layout so it remains usable with the added tab.
- [x] 3.2 Create an admin feature component for the AI Access tab that renders
  the summary cards, primary action area, balance-and-billing section, referral
  section, and advanced diagnostics section.
- [x] 3.3 Add frontend API bindings and action handlers for loading AI Access
  state and invoking provision, top up, refresh, and retry flows.
- [x] 3.4 Ensure the primary UI hides provider key/token/credential plumbing
  from the main surface while still allowing admins to inspect advanced details.

## 4. Validation

- [x] 4.1 Add portal/service tests that cover normalized state derivation for
  not provisioned, funding needed, ready, and error cases.
- [x] 4.2 Add UI tests for the admin AI Access tab covering summary rendering,
  primary CTA changes, and advanced diagnostics visibility.
- [x] 4.3 Verify that automatic setup transitions funded users directly to ready
  when reconciliation succeeds and to error when reconciliation fails.
