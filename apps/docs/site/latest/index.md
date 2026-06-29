# Documentation

This directory is the active documentation tree for the current Polaris work.

Unlike `docs/0.2.2`, this version is not only a snapshot.
It is the maintained reference that should explain how the system works today,
how to operate it, and how to debug it when behavior diverges from expectation.

## Version Model

- `0.2.2`: frozen snapshot
- `latest`: current maintained docs

## Reading Order

If you are new to the repo, read in this order:

1. `polaris/index.md`
2. [operations/remote-deploy.md](./operations/remote-deploy.md)
3. `tooling/workspace/index.md`
4. Maturity notes under `polaris/`

## Current Docs

- [VERSION.md](./VERSION.md): current docs release metadata
- [CHANGELOG.md](./CHANGELOG.md): what changed from `0.2.2`
- `polaris/index.md`: Polaris architecture, lifecycle,
  stack modes, status model, and debugging
- [polaris/isolation-maturity.md](./polaris/isolation-maturity.md): backend
  model and isolation direction
- [polaris/agent-swarm-maturity.md](./polaris/agent-swarm-maturity.md): swarm
  maturity and manager/harness split
- [polaris/evolution-maturity.md](./polaris/evolution-maturity.md): evolution
  and memory kernel
- [polaris/user-management-maturity.md](./polaris/user-management-maturity.md):
  user model maturity
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
