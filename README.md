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

Install the repo skill if you want the shorter prompt:

```bash
pnpm exec tsx scripts/install-skills.ts --target codex use-polaris
```

Install into Claude instead with:

```bash
pnpm exec tsx scripts/install-skills.ts --target claude use-polaris
```

Then use this prompt for the fastest local Docker path:

```text
Use $use-polaris to set up Polaris locally with Docker for project <project>.
```

## Install

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
- [docs/polaris/maturity-map.md](docs/polaris/maturity-map.md)
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
