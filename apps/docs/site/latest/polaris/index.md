# Polaris Overview

Polaris is the control plane for isolated development environments and
external AI coding agents.

If you are reading Polaris for product or customer understanding first, start
here:

- [What Your Team Gets](./what-your-team-gets.md)

That customer-facing path is then expanded into five sections:

- [Onboarding](./onboarding/)
- [Local Deployment](./local-deployment.md)
- [Governed Use](./governed-use/)
- [Shared Infrastructure](./shared-infrastructure/)
- [Member Exit And Handover](./member-exit-and-handover/)

## How To Read Polaris Docs

### Customer-first path

Use this order when you want the business story first:

1. [What Your Team Gets](./what-your-team-gets.md)
2. [Onboarding](./onboarding/)
3. [Local Deployment](./local-deployment.md)
4. [Governed Use](./governed-use/)
5. [Shared Infrastructure](./shared-infrastructure/)
6. [Member Exit And Handover](./member-exit-and-handover/)

### Technical path

Use this order when you want implementation detail and operational depth:

1. [Onboarding](./onboarding/)
2. [Local Deployment](./local-deployment.md)
3. [Governed Use](./governed-use/)
4. [Shared Infrastructure](./shared-infrastructure/)
5. [Member Exit And Handover](./member-exit-and-handover/)
6. [Agent Swarm Maturity](./agent-swarm-maturity.md)

## What Polaris Covers

Polaris currently covers:

- user records and workspace ownership
- user-owned credentials and runtime credential switching
- workspace rendering and lifecycle
- backend isolation boundaries
- daemon readiness, pairing, and status
- evolution memory and handover context

Polaris currently supports:

- `docker`
- `pod`
- `kubevirt-vm`

## Main Entry Points

The main operator, user, and developer surfaces are:

- CLI:

```bash
pnpm --dir apps/polaris run polaris --
```

- stage-one local deployment:

```bash
polaris start
```

Desktop entry:

- `Polaris` app icon

- development-only local web portal:

```bash
pnpm --filter polaris-web exec vite --host 0.0.0.0
```

## Deep Technical References

For deeper operational detail, use the section-specific docs plus:

- [Agent Swarm Maturity](./agent-swarm-maturity.md)
