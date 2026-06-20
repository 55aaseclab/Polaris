# Polaris

Polaris is an AI-native environment for isolated coding agents. It runs
agent workloads in sandboxed Kubernetes pods using Kata Containers and
gVisor, with
[Headlamp](https://headlamp.dev/) managing k3s pods and
[Paseo](https://github.com/getpaseo/paseo) managing the agent runtime inside
each guest or sandbox.

![Platform](https://img.shields.io/badge/platform-k3s-blue)
![Isolation](https://img.shields.io/badge/isolation-Kata%20Containers-6f42c1)
![Runtime](https://img.shields.io/badge/runtime-gVisor-00add8)
![Agent](https://img.shields.io/badge/agent-Codex-0a7ea4)
![Agent](https://img.shields.io/badge/agent-Claude%20Code-d97706)
![UI](https://img.shields.io/badge/ui-Headlamp-2563eb)
![Manager](https://img.shields.io/badge/manager-Paseo-15803d)
![License](https://img.shields.io/badge/license-MIT-black)

## Quick Start

```bash
grep -c vmx /proc/cpuinfo
sudo bash scripts/operations/setup-k3s-kata-gvisor.sh
python3 -m pip install -r requirements.txt
pnpm exec tsx scripts/polaris.ts
```

For tool-specific usage details, start with:

- [docs/README.md](docs/README.md)
- [docs/polaris/README.md](docs/polaris/README.md)
- [docs/operations/README.md](docs/operations/README.md)

If you want to bypass `k3s` entirely and run Morpheus as a plain Docker
container on a single host, use:

```bash
bash scripts/operations/run-morpheus-docker.sh
```

This starts `ttl.sh/morpheus-prebuilt-1781875178:24h` with:

- host root state bound at the Longhorn global mount for `morpheus-project` by default
- optional override: `MORPHEUS_ROOT_DIR=/path/to/root-state`
- repo-local secrets bound at `${MORPHEUS_SECRETS_DIR:-./secrets/polaris}`
- ports `31677`, `31678`, `31679` mapped to `6767`, `8080`, `8081`

If you want to add full VM workloads alongside the existing container
workloads, install KubeVirt with:

```bash
bash scripts/operations/setup-k3s-kubevirt.sh
```

The `morpheus` workload can also run as a KubeVirt VM while keeping the shared
project PVC mounted at `/root`, Docker enabled inside the guest, and the
existing NodePorts (`31677`, `31678`, `31679`) intact.

If you want to extend the underlying k3s/Kata/gVisor setup to more hosts, see
[`scripts/operations/setup-k3s-kata-worker.sh`](scripts/operations/setup-k3s-kata-worker.sh).

## Pitfalls

- do not build with `make -j$(nproc)` inside Kata guests for heavy workloads
  such as Buildroot; `$(nproc)` reflects visible CPUs, but max parallelism can
  overdrive the guest VM and trigger Kata agent timeouts or sandbox restarts.
  Prefer a conservative value such as `-j2` or `-j4` unless you have verified
  the workload is stable with more parallelism
- for `prebuilt` agent images, install persistent tools in the image itself
  rather than expecting `apt_packages` to be installed at pod startup

## Contribute

- update docs when behavior changes
- validate with:

```bash
pnpm exec tsc -p tsconfig.json --noEmit
bash -n scripts/operations/setup-k3s-kata-gvisor.sh
pnpm test:polaris
./tests/smoke-polaris-paseo.sh
```

If you change command flow or generated manifests, update the relevant docs
under `docs/` first.

## License

[MIT LICENSE](LICENSE).
