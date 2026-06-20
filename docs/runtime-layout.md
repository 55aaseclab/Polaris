# Runtime Layout

## Backend Model

- `pod`
  - profiles: `gvisor`, `kata-qemu`, `kata-clh`, `kata-qemu-tdx`
- `kubevirt-vm`
- `docker`
  - currently preserved as a legacy backend boundary during migration

## Config Layout

Long-term target layout:

```text
config/
  specs/
    base/
    pod/
      profiles/
      projects/
    kubevirt/
      projects/
    docker/
      projects/
  generated/
    pod/
    kubevirt/
    docker/
  state/
```

## Current Reality

- New TypeScript code prefers `config/specs/**` and `config/generated/**`.
- Legacy saved configs still exist under:
  - `config/gvisor/specs/`
  - `config/kubevirt/specs/`
- Legacy generated manifests still exist under:
  - `config/gvisor/generated/`
  - `config/kubevirt/generated/`
- The migration is intentionally gradual so the new control plane can coexist
  with the old layout until backend execution logic is fully moved out of
  Python.
