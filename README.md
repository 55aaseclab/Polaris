# Polaris

Self-hosted workspace control plane for isolated development environments and
external AI coding agents.

[Quickstart](#quickstart) | [Documentation](docs/README.md)

![Platform](https://img.shields.io/badge/platform-self--hosted-blue)
![Backends](https://img.shields.io/badge/backends-pod%20%7C%20docker%20%7C%20kubevirt-2563eb)
![Manager](https://img.shields.io/badge/manager-Paseo-15803d)
![License](https://img.shields.io/badge/license-MIT-black)

Polaris is a workspace control plane.

It manages development environments across `pod`, `docker`, and
`kubevirt-vm` backends.

It keeps the agent layer external and replaceable.

Today that means:

- workspace specs are the source of truth
- generated backend artifacts remain outputs
- Docker is the clean default onboarding path
- agent orchestration is built around `Paseo`
- coding harnesses such as `Codex` and `Claude` stay external to Polaris

## Quickstart

The fastest path is local Docker.

```bash
pnpm install
pnpm exec tsx scripts/polaris.ts create <project>
pnpm exec tsx scripts/polaris.ts render <project>@docker
pnpm exec tsx scripts/polaris.ts start <project>@docker
pnpm exec tsx scripts/polaris.ts status <project>@docker
pnpm exec tsx scripts/polaris.ts logs <project>@docker
```

Stage bootstrap secrets before starting the workspace:

```text
secrets/polaris/
  codex/auth.json
  codex/config.toml
  claude/settings.json
```

Override the default secret mount source with `POLARIS_SECRETS_DIR` when
needed.

## Install

### Local Docker

Use the Docker path when you want the shortest route from clone to running
workspace.

```bash
pnpm install
pnpm exec tsx scripts/polaris.ts create <project>
pnpm exec tsx scripts/polaris.ts start <project>@docker
```

### Kubernetes Pods

Use the pod backend when you want stronger sandboxing and the existing k3s
runtime path.

```bash
sudo bash scripts/operations/setup-k3s-kata-gvisor.sh
pnpm exec tsx scripts/polaris.ts start morpheus@pod
```

### KubeVirt

Use the KubeVirt backend when you want full VM workloads managed by the same
control plane.

```bash
bash scripts/operations/setup-k3s-kubevirt.sh
pnpm exec tsx scripts/polaris.ts start morpheus@kubevirt-vm
```

## Documentation

Start here:

- [docs/README.md](docs/README.md)
- [docs/polaris/README.md](docs/polaris/README.md)
- [docs/polaris/runtime-layout.md](docs/polaris/runtime-layout.md)
- [docs/polaris/comparison-with-coder.md](docs/polaris/comparison-with-coder.md)
- [docs/operations/README.md](docs/operations/README.md)

## Contributing

Keep generated artifacts in sync with the TypeScript control plane.

Do not treat generated backend manifests as hand-maintained files.

Validate changes with:

```bash
pnpm run check
pnpm run test:polaris
bash tests/smoke-polaris-paseo.sh
```

If you change command flow, backend behavior, or onboarding, update the
relevant docs under `docs/`.

## License

[MIT](LICENSE)
