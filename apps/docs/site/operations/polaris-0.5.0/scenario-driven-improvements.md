# 0.5.0 场景驱动的可提升项

Date: 2026-08-09

Status: planned improvement backlog for Polaris **0.5.0**. Derived from
[use scenarios](/business-model/use-scenarios),
[target customers](/business-model/target-customers-and-roadmap), and the
shipped [0.3.3 baseline](../polaris-0.3.3/twenty-user-resource-baseline.md).

This is not a capacity claim beyond 20, and not a rewrite of the
Polaris/private surface boundary.

## Why 0.5.0 Exists

0.3.x proved a single-host control plane and a **20 active vault** package.
0.4.0 plans work/workflow surfaces. Real buyers in the 10–20 isolation band
still hit product gaps before they will run a semester lab, a delivery pod, or
a pure **local deployment** without Authing.

The sharpest example:

> Strong local-deploy demand needs a **local user authentication system**.

Authing-only identity blocks air-gapped enterprises, many campus labs, and
exam/course installs that refuse external IdP. `POLARIS_AUTH_MODE=disabled` is
a lab fixture, not a multi-user product.

## Improvement Map (by theme)

### A. Local identity and access (P0)

| Gap | Today | 0.5.0 target | Scenarios |
| --- | --- | --- | --- |
| Local user auth | Authing browser session, or single disabled dev user | First-class **local account** mode: create user, password/passkey or invite, login, logout, session | E1–E3, U1–U2, S07–S10, S22 |
| Local admin of users | CLI / files / user-map oriented | Admin API + minimal UI: list, disable, reset, role, line | all multi-user |
| Map local identity → Polaris user/vault ownership | Works for Authing map; weak for pure local | Same ownership model for local subjects; no second control plane in private surface | all |
| Cohort accounts | Manual | Bulk create N local users for a class/exam with one operation | S07, S08, S09, S10 |
| Offline / air-gap | Needs external Authing URLs | Local mode runs with **no outbound IdP** | campus, regulated E13 |

**Design constraints**

- Local auth is another `POLARIS_AUTH_MODE`, not a parallel policy engine.
- Production formal origin may keep Authing; local mode is for local-test and
  air-gapped single-host cells.
- Disabled auth remains fixture-only; must not be the multi-seat answer.
- Password storage, lockout, and invite tokens need durable audit events.

### B. Cohort and vault lifecycle (P0/P1)

| Gap | Today | 0.5.0 target | Scenarios |
| --- | --- | --- | --- |
| Batch vault create | One-by-one CLI | Cohort API: N vaults, same image, naming template | S07–S10, S08 |
| Timed expiry | Manual stop/delete | Optional `expiresAt` / TTL; sweeper job reclaims | exam, hackathon, PoC |
| Creator-destroys automation | Documented discipline | Official cleanup job: containers, **networks**, volumes, users matching cohort id | all short-life |
| Docker address pools | Default pool dies ~7 user networks on some hosts | Documented daemon pool preset + preflight check for ≥24 networks | 20 hot vaults |
| Pre-warm pool | Cold start per user | Optional warm idle vaults for exam start spike | S08, S10 |

### C. Isolation evidence and admin visibility (P1)

| Gap | Today | 0.5.0 target | Scenarios |
| --- | --- | --- | --- |
| “Prove they cannot see each other” | Architecture + tests | Operator isolation check report (two synthetic tenants, redacted) | security buyers |
| Who is active / over quota | Partial APIs | Admin host list: vault, user, age, storage, last active | E3, U1 |
| Stale vault detection | Manual | Mark stale; one-click reclaim policy | lab, delivery |
| Audit export | Internal | Export pack for pilot questionnaire (login, launch, deny) | E2, E13, S08 |

### D. Scenario packs (P1)

Thin templates, not separate products:

| Pack | Defaults | Scenarios |
| --- | --- | --- |
| `lab-cell` | 20 seats, long TTL, Authing or local | S01, S06 |
| `course-cohort` | N students, shared image, medium TTL | S07, S09 |
| `exam-session` | N candidates, short TTL, strict cleanup, optional network tighten | S08 |
| `delivery-pod` | project-scoped vaults, handover notes | S02, S19 |
| `ephemeral-event` | hackathon/GameDay/PoC, destroy-all | S10, S20, S22 |

Packs only compose existing Polaris knobs (users, vaults, quotas, TTL,
cleanup). They must not invent a second orchestrator in private surface.

### E. Local deploy productization (P0)

| Gap | Today | 0.5.0 target |
| --- | --- | --- |
| Install story | Operator-heavy remote scripts | One documented **air-gap / campus local** path: images, env, local auth bootstrap admin |
| IdP optional | Authing required for “real” multi-user | Local auth bootstrap + optional later link to Authing/OIDC |
| Capacity honesty | 0.3.3 baseline exists | Installer/preflight prints host fit vs 20-seat table (RAM, CPU, disk, **network pool**) |
| Backup/restore narrative | Exists as jobs | Pilot-facing “what we backup / what we do not” one-pager |

### F. Intentionally later (not 0.5.0 core)

- Beating Cursor on personal laptop UX
- Mass non-CS consumer GPT surface
- Multi-host 50/100 without measured host classes
- Full browser two-tenant matrix polish if still owned by 0.3.2 track
- Replacing every campus IdP with only local passwords long-term

## Priority Slice For 0.5.0

Suggested build order:

1. **Local auth mode** (accounts, sessions, admin CRUD, bootstrap admin)
2. **Preflight: Docker network pool + 20-seat host fit**
3. **Cohort batch create + TTL sweeper + network-inclusive destroy**
4. **Admin active/stale/quota view**
5. **Exam/course/lab packs as config+docs+scripts**, not new daemons
6. **Isolation/audit export pack** for pilot security

## Acceptance Sketch

0.5.0 is ready to pilot when:

1. A pure local install can create 20 local users **without Authing**, each
   with an isolated vault, login, and logout.
2. A cohort of 20 can be created and **fully destroyed** (users, vaults,
   containers, **networks**, volumes) by one operator action or job.
3. Preflight refuses hosts that cannot provide network pool headroom for the
   declared active-vault ceiling.
4. An admin can answer “who is on, who is over quota, what is stale” without
   SSH archaeology.
5. Authing mode still works on formal/enterprise cells; local mode does not
   weaken gateway isolation rules.

## Relation To Other Releases

| Release | Focus |
| --- | --- |
| 0.3.x | Control plane, perimeter, **20-seat capacity identity** |
| 0.4.0 | WorkEnvelope, workflow IR, activity → workflow |
| **0.5.0** | **Local identity, cohort lifecycle, scenario packaging, local deploy** |

0.5.0 should consume 0.3.3 limits and may call 0.4.0 work items later (for
example exam “submit” as a work envelope). It must not block 0.4.0, and must
not move identity or lifecycle ownership into private surface.
