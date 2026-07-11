## Why

Polaris currently has an authenticated web portal, but it does not have a
product-owned unauthenticated shell for visitors who are deciding whether to
start personally or buy for a team. The first public page should express the
Polaris product promise before authentication, while leaving room for future
auth to move into Polaris itself.

The page must also serve two buying motions from day one:

- personal users who want fast access to an AI workspace with little setup
- enterprise teams that need onboarding, ownership, isolation, credential
  control, and handover continuity

## What Changes

- Add a new `apps/landing-page` Vite React app for the first Polaris landing
  page.
- Present Polaris as an AI workspace platform with distinct personal and
  enterprise paths.
- Ground enterprise messaging in onboarding, governed use, shared
  infrastructure with isolation, and member exit handover continuity.
- Keep CTA structure compatible with future in-Polaris sign-in and sign-up
  routes, while allowing placeholder or current-route links for the first
  implementation.
- Use a branded visual system rather than generic AI SaaS styling.

## Capabilities

### New Capabilities

- `polaris-landing-shell`: unauthenticated Polaris product shell for personal
  and enterprise buying motions.

### Modified Capabilities

- None.

## Impact

- Adds a new app under `apps/landing-page`.
- Adds landing-page build and typecheck scope without changing the existing
  authenticated `polaris-web` portal.
- Does not change current Clerk behavior or backend authorization.
