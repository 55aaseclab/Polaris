# Development

The [Polaris PRD](./prd) is the single ground truth for product scope.
Planning is not expressed as dated release pages; scope, flows, roles, and
priorities live in the PRD, and the PRD wins on conflict.

## Current Path

1. Read [Polaris PRD](./prd) first. It defines what Polaris is, what it does,
   and what ships next.
2. Read the [Q4 roadmap](./roadmap) for release slicing and scheduling. It
   derives from the PRD and cuts the inventory into cross-activity slices.
3. Read [User Management](/polaris/user-management) for identity, ownership,
   product-line, and capability decisions.
4. Read [Polaris Portal](/polaris/polaris-portal) for browser routes, host
   projections, and live status behavior.
5. Read [Vault Management](/polaris/vault-management) for topology, data,
   runtime, and single-host service ownership.
6. Read [Polaris Gateway](/polaris/gateway) for the public ingress and
   authority boundary.
7. Read [Polaris Workflow](/polaris/workflow) for the workflow reference.
8. Read [Remote Deploy](./remote-deploy.md) for host layout and rollout.
9. Read [Infamous Regression](./infamous-regression.md) for the incident
   record.

## Boundary Rules

Polaris owns identity, tenant and vault ownership, roles, rate limits, quotas,
lifecycle, durable jobs, audit, and ingress. Vault Management is the canonical
reference for the selected vault's topology, data, runtime, and mount contract.

## Ground-Truth Rules

- The PRD is the only ground truth for product scope and priorities.
- A passing unit test is not production evidence; a shipped capability must
  also appear in the PRD functional inventory.
- Product reference pages describe behavior; the PRD decides whether that
  behavior is the intended scope. Fix the PRD first when they disagree.
