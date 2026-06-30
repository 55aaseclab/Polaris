# Documentation

This directory is the active documentation tree for the current Polaris work.

Unlike the frozen release snapshots, this version is not only a snapshot.
It is the maintained reference that should explain how the system works today,
how to operate it, and how to debug it when behavior diverges from expectation.

## Version Model

- `0.2.2`: earlier frozen snapshot
- `0.2.3`: earlier release snapshot
- `0.2.4`: earlier release snapshot
- `0.2.5`: current release snapshot
- `latest`: current maintained docs

## Reading Order

If you are new to the repo, read in this order:

1. [polaris/what-your-team-gets.md](./polaris/what-your-team-gets.md)
2. [polaris/onboarding/](./polaris/onboarding/)
3. [operations/remote-deploy.md](./operations/remote-deploy.md)
4. `tooling/workspace/index.md`
5. Maturity notes under `polaris/`

## Current Docs

- [VERSION.md](./VERSION.md): current docs release metadata
- [CHANGELOG.md](./CHANGELOG.md): what changed from `0.2.5`
- [business-model/](./business-model/): market analysis, customer segmentation,
  and Polaris positioning
- [polaris/what-your-team-gets.md](./polaris/what-your-team-gets.md): customer-facing
  explanation of Polaris through onboarding, governed use, shared
  infrastructure, and member exit
- [polaris/onboarding/](./polaris/onboarding/): onboarding around shared Docker
  foundations and workspace command surfaces
- [polaris/governed-use/](./polaris/governed-use/): ownership and runtime
  credential switch
- [polaris/shared-infrastructure/](./polaris/shared-infrastructure/): isolation,
  runtime state, and backend switching
- [polaris/member-exit-and-handover/](./polaris/member-exit-and-handover/):
  personal context, team context, and handover continuity
- [polaris/governed-use/ownership-model.md](./polaris/governed-use/ownership-model.md):
  ownership of users, workspaces, and credentials
- [polaris/governed-use/credential-switch.md](./polaris/governed-use/credential-switch.md):
  runtime credential switch behavior for supported harnesses
- [polaris/governed-use/clerk-integration.md](./polaris/governed-use/clerk-integration.md):
  Clerk mapping, portal responsibilities, and retained legacy notes
- `polaris/index.md`: Polaris entry page for customer and technical reading
  paths
- [polaris/agent-swarm-maturity.md](./polaris/agent-swarm-maturity.md): swarm
  maturity and manager/harness split
- [operations/remote-deploy.md](./operations/remote-deploy.md): deployment,
  host ownership, and rollback path
- [operations/setup-k3s-across-multiple-machines.md](./operations/setup-k3s-across-multiple-machines.md):
  cluster notes
- `tooling/workspace/index.md`: workspace-side
  optional tools
- `tooling/host/index.md`: host-side helper tools

## Documentation Principles

- Treat docs as versioned product artifacts.
- Keep release snapshots immutable.
- Put current operational truth in `docs/latest`.
- Prefer explicit paths, ports, and ownership boundaries.
- Document both the happy path and the debug path.
