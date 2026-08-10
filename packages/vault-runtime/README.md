# @polaris/vault-runtime

`@polaris/vault-runtime` contains the reusable execution layer for one Vault
runtime. It renders and drives Docker, Pod, and KubeVirt backends from the
runtime-only `VaultRuntimeSpec` contract.

The package owns runtime mechanics: names, attachment assembly, identity mount
layout, manifests, lifecycle commands, observations, and reconcile actions. It
does not own Authing identity, tenant or Vault ownership, authorization, quota,
gateway policy, secrets, audit persistence, or lifecycle policy. Polaris remains
the control plane and projects its full `VaultSpec` into this package.

Run the package independently from the repository root:

```sh
pnpm --filter @polaris/vault-runtime run check
pnpm --filter @polaris/vault-runtime run test
```

Package tests use synthetic runtime fixtures and package-owned KubeVirt template
fixtures. Polaris tests continue to cover the adapter and control-plane
integration contract.
