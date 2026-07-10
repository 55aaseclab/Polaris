## Why

Polaris currently exposes user credentials as low-level technical assets, but
it does not provide a product surface for provisioning paid AI access, funding
that access, or understanding whether a user is ready to use it. We need a
single admin-pane experience that models the user journey as platform access
and balance management rather than as API key and credential plumbing.

## What Changes

- Add a new `AI Access` tab in the admin pane for a selected user.
- Show a normalized access summary focused on access state, billing mode,
  available balance, and referral availability.
- Drive the page from a small user-facing state model:
  `not_provisioned`, `funding_needed`, `ready`, and `error`.
- Support a pay-as-you-go first flow where the primary actions are
  `Provision Access`, `Top Up`, and `Retry`.
- Keep provider-specific key, token, and credential details out of the primary
  UX and move them into an admin-only advanced section.
- Introduce a provider adapter model so the experience is not coupled to
  `New API`, even though `New API` can be the first backend.
- Treat runtime setup and credential synchronization as automatic background
  work rather than as user-visible setup steps.

## Capabilities

### New Capabilities
- `ai-access-subscription-panel`: User-scoped AI access, pay-as-you-go funding,
  referral, and readiness status surfaced through a normalized admin-pane tab.

### Modified Capabilities
- None.

## Impact

- `apps/polaris-web/src/App.tsx` admin navigation and selected-user detail UI
- New admin feature component(s) for the `AI Access` tab
- `apps/polaris-web/src/lib/api.ts` client bindings for AI access data/actions
- `apps/polaris/scripts/portal/server.ts` new portal endpoints
- `apps/polaris/scripts/portal/service.ts` aggregation and action orchestration
- New provider adapter layer for backend-specific access, funding, and referral
  integration
