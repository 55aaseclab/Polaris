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
6. Read [Polaris Workflow](/polaris/workflow) for the workflow reference and the
   consolidated workflow evolution plan.
7. Read [Polaris 0.5.0](./polaris-0.5.0/) for the cloud service, WeChat Mini
   Program, Web Portal, Workflow API, and subscription workflows. Read
   [Polaris 1.0.0](./polaris-1.0.0/) for production reliability,
   explainability, recovery, and audit requirements. Read
   [Polaris 2.0.0](./polaris-2.0.0/) for the future local deployment,
   offline identity, 20-seat isolation, and operator requirements.
The release records are deliberately separate from product reference pages.
A passing unit test is not production evidence.

## Boundary Rules

Polaris owns identity, tenant and vault ownership, roles, rate limits, quotas,
lifecycle, durable jobs, audit, and ingress. Vault Management is the canonical
reference for the selected vault's topology, data, runtime, and mount contract.
