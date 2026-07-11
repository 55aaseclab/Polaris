## ADDED Requirements

### Requirement: The landing shell SHALL present personal and enterprise buying
motions
The Polaris unauthenticated shell SHALL present clear personal and enterprise
entry paths before authentication.

#### Scenario: Visitor can choose personal access
- **WHEN** a visitor arrives on the landing page
- **THEN** the page SHALL offer a personal CTA for starting with a Polaris AI
  workspace

#### Scenario: Visitor can choose enterprise evaluation
- **WHEN** a visitor arrives on the landing page
- **THEN** the page SHALL offer an enterprise CTA for team or organization
  evaluation

### Requirement: Personal messaging SHALL emphasize fast AI workspace access
The landing shell SHALL position the personal motion around immediate usable AI
workspace access, low setup friction, starter value, and invite/referral growth
without using literal connectivity, free-quota, or rebate wording.

#### Scenario: Personal value is visible in the first visit
- **WHEN** a personal developer scans the page
- **THEN** the page SHALL describe a quick path into a usable AI workspace with
  starter value

#### Scenario: Invite growth is professional
- **WHEN** the page references invite or referral growth
- **THEN** it SHALL frame the benefit as workspace expansion or teammate invite
  value instead of rebate language

### Requirement: Enterprise messaging SHALL express governed workspace control
The landing shell SHALL position the enterprise motion around onboarding,
ownership, isolation, credential control, and continuity when members leave or
change roles.

#### Scenario: Enterprise operator sees control-plane value
- **WHEN** an enterprise operator scans the page
- **THEN** the page SHALL describe onboarding, ownership, isolation, and
  credential control as product capabilities

#### Scenario: Member exit concern is professionally represented
- **WHEN** the page describes handover or offboarding
- **THEN** it SHALL explain that team-owned project context and continuity stay
  with the organization when people leave or change roles

### Requirement: The landing shell SHALL preserve future Polaris-owned auth
The landing shell SHALL structure sign-in, sign-up, and enterprise CTAs as
Polaris shell actions and SHALL NOT depend on the current external auth-site
mental model.

#### Scenario: Auth routes are placeholders for Polaris-owned flows
- **WHEN** a CTA links to sign-in or sign-up
- **THEN** the route SHALL be expressed as a Polaris shell route or neutral
  placeholder that can later be wired to in-product authentication

### Requirement: The landing shell SHALL use a branded non-generic visual
system
The landing shell SHALL use a distinctive visual system suitable for Polaris
and SHALL avoid generic purple-on-white AI SaaS template aesthetics.

#### Scenario: Page expresses product identity
- **WHEN** a visitor views the first screen
- **THEN** the page SHALL show Polaris as a workspace control layer through
  typography, layout, color, and product-state visuals
