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

Run the local stack:

```bash
bash ./scripts/deploy-polaris-host.sh .env.dev
```

This starts `polaris-executor` on the host.

It starts `polaris-server`, `polaris-webportal`, `paseo-app`, and `nginx`
through Docker Compose.

The default local ports are:

- nginx: `18080`
- polaris-server: `18787`
- polaris-webportal: `18081`
- paseo-app: `18082`
- polaris-executor: `18788`

Use `.env.dev` for real local values.

For local testing from another network, set the public IP-based URLs in
`.env.dev`.

The main ones are:

- `VITE_PASEO_APP_BASE_URL`
- `POLARIS_PASEO_APP_BASE_URL`
- `NEXT_PUBLIC_CLERK_SIGN_IN_URL`
- `NEXT_PUBLIC_CLERK_SIGN_UP_URL`

Use `.env.dev.example` and `.env.deploy.example` as templates.

Polaris expects shared Clerk auth URLs in the env file.

It no longer serves local `/sign-in` or `/sign-up` Clerk UI pages.

## Deploy

Deploy the stack:

```bash
bash ./scripts/deploy-polaris-host.sh .env.deploy
```

Access it through nginx on the public hostname.

The host executor stays local-only.

The default deploy ports are:

- nginx: `80`
- polaris-server: `8787`
- polaris-webportal: `8081`
- paseo-app: `8082`
- polaris-executor: `8788`

Keep real values in `.env.deploy`.

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
pnpm run test:polaris
```

If you change command flow, backend behavior, or onboarding, update the
relevant docs under `docs/`.

## License

[MIT](./LICENSE)
