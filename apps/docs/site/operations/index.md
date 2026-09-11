# Operations

This section is the single operator path for Polaris and its retained private
surface boundaries.

## Current Path

1. Read [User Management](/polaris/user-management) for identity, ownership,
   product-line, and capability decisions.
2. Read [Polaris Portal](/polaris/polaris-portal) for browser routes, host
   projections, and live status behavior.
3. Read [Vault Management](/polaris/vault-management) for topology, data,
   runtime, and single-host service ownership.
4. Read [Polaris Gateway](/polaris/gateway) for the public ingress and
   authority boundary.
5. Read [Remote Deploy](./remote-deploy.md) for host layout and rollout.
6. Read [Polaris 0.3.4](./polaris-0.3.4/) for the current shipped baseline;
   use [Polaris 0.3 Release](./polaris-release/) for the original 0.3 gates,
   evidence, and go/no-go record.
7. Read [archived Polaris 0.3.1](./polaris-0.3.1/) for performance work, then
   [archived Polaris 0.3.2](./polaris-0.3.2/) for the production perimeter, and the
   [archived Polaris 0.3.3](./polaris-0.3.3/) for user-count growth, storage
   capacity, migration, and scale evidence. Read [Polaris 0.4.0](./polaris-0.4.0/)
   for the WorkEnvelope, auditable work feed, and behavior-to-workflow plan.
   The Domain Pack language itself is on [Polaris DSL](/polaris/dsl).
   Read [Polaris 0.5.0](./polaris-0.5.0/) for local identity, cohort
   lifecycle, and scenario packaging on the 20-seat cell.
The release records are deliberately separate from product reference pages.
A passing unit test is not production evidence.

## Boundary Rules

Polaris owns identity, tenant and vault ownership, roles, rate limits, quotas,
lifecycle, durable jobs, audit, and ingress. Vault Management is the canonical
reference for the selected vault's topology, data, runtime, and mount contract.
