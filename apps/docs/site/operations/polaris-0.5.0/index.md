# Polaris 0.5.0

Status: planned. This release turns the 0.3.x single-host control plane and
the 0.4.0 work/workflow surface into a **sellable 10–20 seat local cell** for
enterprise pilots, university labs, courses, and short-lived cohorts.

It does not replace 0.4.0 workflow work. It packages isolation, identity,
lifecycle, and operator experience so the scenarios in
[Use scenarios](/business-model/use-scenarios) stop depending on
Authing-only identity or hand-built scripts.

## Objective

Make “one host, about twenty isolated daily AI users” operable **without a
cloud IdP** when the buyer demands pure local deployment, and still clean when
cohorts are short-lived (class, exam, hackathon, PoC).

## Scope Themes

1. **Local identity** — first-class local user authentication and admin of
   users/roles without Authing.
2. **Cohort lifecycle** — batch create, timed expiry, and creator-destroys
   cleanup including Docker networks.
3. **Operator product surface** — admin views for active vaults, quota, stale
   users, and isolation health.
4. **Scenario packs** — lab, course, delivery, exam/drill templates on top of
   the 20-seat baseline.
5. **Evidence for buyers** — isolation and audit exports good enough for a
   pilot security questionnaire.

## Documents

- [Gaps and improvements from scenarios](./scenario-driven-improvements.md)

## Dependencies

- 0.3.3 capacity identity (`maxActiveVaults=20`) and resource baseline remain
  the package size.
- 0.4.0 WorkEnvelope/workflow work can proceed in parallel; 0.5.0 must not
  make private surface a second identity or lifecycle control plane.
- Formal Authing mode stays supported; local auth is an additional mode for
  air-gapped and campus-local installs, not a removal of enterprise IdP.
