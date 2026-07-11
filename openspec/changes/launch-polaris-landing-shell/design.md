## Context

Polaris already models user-owned workspaces, user-scoped credentials,
workspace isolation, runtime control, and member handover. The landing page
should make that product meaning visible before authentication.

Existing docs position Polaris as a governed agent workspace platform rather
than another coding assistant or workflow builder. The page should still offer
a personal entry motion, but the brand center should remain workspace
ownership, usable environments, credential control, isolation, and continuity.

## Goals / Non-Goals

**Goals:**

- Create a visually strong public Polaris shell in `apps/landing-page`.
- Support personal and enterprise CTAs in the hero and final CTA.
- Communicate personal value as immediate AI workspace access with low setup
  friction and starter value.
- Communicate enterprise value as onboarding, ownership, isolation, credential
  control, and continuity when members leave or change roles.
- Preserve future auth integration by treating sign-in and sign-up as Polaris
  shell actions instead of a separate product.

**Non-Goals:**

- Replace the authenticated `apps/polaris-web` portal in this change.
- Implement live account creation, billing, or enterprise lead capture
  backends.
- Change Clerk integration or portal authorization behavior.
- Add a pricing system or product packaging model beyond CTA framing.

## Visual Direction

The first version uses an editorial operations-console aesthetic:

- large confident typography with a dense control-plane composition
- ivory, graphite, oxide red, brass, and cyan accents instead of purple AI
  gradients
- product-like panels that show workspaces, credentials, ownership, and
  handover state
- motion through CSS-only staggered reveals and hover states

This direction should feel like a serious workspace operating layer with enough
energy for individual adoption, not a generic assistant template.

## Decisions

- Build the page as a new Vite React app because existing repo frontends use
  Vite, React, TypeScript, and Tailwind.
- Keep CTA links as simple anchors in the first version:
  `/sign-up?motion=personal`, `/enterprise`, and `/sign-in`.
- Keep the copy independent from the current external auth-site mental model.
  The route names are placeholders for future Polaris-owned auth.
- Include both buying motions in the first viewport and again near the final
  CTA so users can choose without hunting.
- Include a product mock surface instead of stock imagery. The mock surface
  reflects current Polaris concepts: workspace state, credential ownership,
  runtime isolation, onboarding, and handover continuity.
- Use CSS variables for the brand palette and typography so the design can move
  into Polaris later.

## Risks / Trade-offs

- [Risk] A standalone app can drift from future Polaris shell routes.
  Mitigation: keep links and copy route-agnostic and document that auth moves
  into Polaris later.
- [Risk] Personal positioning could dilute enterprise platform value.
  Mitigation: keep personal copy focused on fast workspace access while making
  the page's core product model ownership and governed continuity.
- [Risk] Static CTA targets are not wired to backend flows.
  Mitigation: treat them as placeholders and avoid adding fake integrations.
