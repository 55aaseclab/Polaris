## Context

Polaris already has user-scoped admin tabs for profiles, credentials, skills,
workspaces, and Paseo. The current product surface for model access is still
credential-centric: operators create or edit provider credentials directly and
must understand provider names, base URLs, and key material. That model does
not fit the intended user journey for paid AI access, where the primary
questions are whether access is provisioned, whether the user has available
balance, and whether access is ready to use.

The first backend can be `New API`, but the feature must not couple the UI or
portal APIs to `New API` naming or backend-specific lifecycle concepts. The
panel must also remain compatible with a future user-facing surface, so the
admin-pane version should already speak in user product terms instead of
engineering implementation terms.

## Goals / Non-Goals

**Goals:**
- Add an `AI Access` admin-pane tab that shows a selected user's product-level
  access state.
- Normalize provider-specific state into a small pay-as-you-go-first model:
  `not_provisioned`, `funding_needed`, `ready`, and `error`.
- Make runtime setup and credential synchronization automatic background work,
  not a visible user step.
- Separate provider integration facts from UI view-model derivation so multiple
  backends can be supported later.
- Preserve an admin-only advanced section for diagnostics without making token,
  key, or credential details part of the primary UX.

**Non-Goals:**
- Recreate a provider's full native admin console inside Polaris.
- Expose raw API key or token management as the primary product flow.
- Deliver a multi-plan marketplace or subscription-comparison UX in V1.
- Build a general public user-facing page in this change; the initial surface
  lives in the admin pane while matching future user-facing semantics.

## Decisions

### Decision: Model the tab around product access instead of credentials

The new tab will be named and structured as `AI Access`, not as a credential or
provider management page. The top-level cards will focus on access state,
billing mode, available balance, and referral availability.

Rationale:
- This aligns the page with the intended user journey.
- It avoids binding the product concept to `New API`.
- It allows the same surface to move into a user-facing context later.

Alternative considered:
- Extending the existing credentials tab. Rejected because that keeps the UX
  centered on provider plumbing and mixes business state with credential files.

### Decision: Use a three-state happy path plus one error state

The user-visible state model will be:
- `not_provisioned`
- `funding_needed`
- `ready`
- `error`

`setup_pending` will not be a stable user-visible state. If runtime setup or
credential synchronization is incomplete, Polaris will attempt to complete it
automatically. Only failed automation will surface as `error`.

Rationale:
- The product currently prioritizes pay-as-you-go funding, not a multi-step
  technical setup journey.
- This keeps the page simple enough for a future user-facing version.

Alternative considered:
- Exposing `setup_pending` as a normal page state. Rejected because it leaks
  internal credential and token setup into the user narrative.

### Decision: Introduce a provider adapter facts layer

Portal services will query a provider adapter interface that returns normalized
 provider facts such as provisioning status, funding facts, referral facts,
health status, and setup readiness facts. Polaris will then derive the final
`AI Access` view model and allowed actions from those facts.

Rationale:
- Providers differ in account, funding, and referral APIs.
- The UI should not know provider-specific response shapes.
- The same aggregation layer can support both admin and future user surfaces.

Alternative considered:
- Letting the frontend call provider-specific endpoints and derive state
  itself. Rejected because it would hard-code provider semantics in the UI and
  complicate future backend swaps.

### Decision: Keep key and credential details in an advanced diagnostics area

The page will have an advanced section that can show provider backend identity,
internal account linkage, token presence, credential sync status, and recent
error details. These details are diagnostic and admin-only.

Rationale:
- Admins need observability during rollout.
- The main UX must remain free of provider-specific key management.

Alternative considered:
- Removing internal details entirely. Rejected because this would make rollout
  and support debugging unnecessarily opaque.

### Decision: Make pay-as-you-go the primary billing mode in V1

The primary call to action for an already provisioned but unfunded user will be
`Top Up`. Plan-management concepts remain compatible fields in the view model
but will not dominate the V1 layout.

Rationale:
- Current product direction is explicitly usage-funded first.
- This keeps the page centered on the most common action.

Alternative considered:
- Leading with subscription or plan selection. Rejected because it does not
  match the current commercial path.

## Risks / Trade-offs

- **[Provider capability mismatch]** → The first provider may not support every
  fact or action cleanly. Mitigation: model provider capabilities explicitly and
  degrade unsupported cards or actions gracefully.
- **[Automatic setup hides real failures]** → Background setup can fail without
  an obvious reason. Mitigation: promote failed automation into a clear `error`
  state and expose diagnostics in the advanced section.
- **[Admin-pane-first implementation drifts from future user UX]** → The first
  version could accidentally become an operator console. Mitigation: keep the
  primary language and state model user-facing from the start.
- **[Scope creep into full billing console]** → Recharge, plans, usage, and
  referrals can expand quickly. Mitigation: keep V1 centered on summary,
  funding, referral, and readiness only.

## Migration Plan

1. Add backend aggregation endpoints and provider adapter plumbing without
   changing existing credential flows.
2. Add the `AI Access` tab in the admin pane behind normal admin routing.
3. Validate that automatic setup can reconcile provider access with Polaris
   runtime readiness before marking a user `ready`.
4. Roll back by hiding the tab and disabling the new endpoints if provider
   integration proves unstable.

## Open Questions

- Which provider capability fields should be mandatory versus optional for the
  first adapter implementation?
- Should `usage` remain fully out of V1, or should a minimal recent-consumption
  summary be exposed once funding is live?
- How should Polaris persist provider linkage metadata so it remains auditable
  without leaking provider secrets into user-editable files?
