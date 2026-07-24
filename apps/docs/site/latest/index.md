# Documentation

This is the maintained Polaris documentation tree.

It explains how the system works today, how to operate it, and how to debug it
when behavior diverges from expectation.

## Reading Order

If you are new to the repo, read in this order:

1. [polaris/what-your-team-gets.md](./polaris/what-your-team-gets.md)
2. [polaris/onboarding/](./polaris/onboarding/)
3. [operations/remote-deploy.md](./operations/remote-deploy.md)
4. `tooling/workspace/index.md`
5. Maturity notes under `polaris/`

## Current Docs

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

- Prefer explicit paths, ports, and ownership boundaries.
- Document both the happy path and the debug path.
