# Polaris

Self-hosted workspace control plane for isolated development environments and
external AI coding agents.

[Quickstart](#quickstart) | [Documentation](./docs/README.md)

![Platform](https://img.shields.io/badge/platform-self--hosted-blue)
![Backends](https://img.shields.io/badge/backends-pod%20%7C%20docker%20%7C%20kubevirt-2563eb)
![Manager](https://img.shields.io/badge/manager-Paseo-15803d)
![License](https://img.shields.io/badge/license-MIT-black)

Polaris is a workspace control plane.

It manages development environments across `pod`, `docker`, and
`kubevirt-vm` backends.

It keeps the agent layer external and replaceable.

Today that means you can run one machine or a fleet of them, create an
isolated workspace from a spec, and use the full capacity of your own hardware
while controlling the experience from your phone or a web portal.

## Quickstart

Start the Polaris web portal:

```bash
pnpm --dir apps/polaris run polaris -- portal
```

Then open the portal in your browser:

```text
http://127.0.0.1:8787/
```

The portal redirects to the first configured user and exposes workspaces under
explicit user routes such as:

```text
/users/<user_id>/workspaces
/users/<user_id>/workspaces/<workspace_name>
/users/<user_id>/credentials
```

## Documentation

- [docs/polaris/README.md](./docs/polaris/README.md)
- [docs/polaris/control-plane-maturity.md](./docs/polaris/control-plane-maturity.md)
- [docs/polaris/isolation-maturity.md](./docs/polaris/isolation-maturity.md)
- [docs/polaris/agent-swarm-maturity.md](./docs/polaris/agent-swarm-maturity.md)
- [docs/polaris/evolution-maturity.md](./docs/polaris/evolution-maturity.md)
- [Support multiple machines with k3s](./docs/operations/setup-k3s-across-multiple-machines.md)

## Contributing

Keep generated artifacts in sync with the TypeScript control plane.

Do not treat generated backend manifests as hand-maintained files.

Validate changes with:

```bash
pnpm run check
pnpm run test
```

If you change command flow, backend behavior, or onboarding, update the
relevant docs under `docs/`.

## License

[MIT](./LICENSE)
