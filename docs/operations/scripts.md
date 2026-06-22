# Scripts

## Active Scripts

- `apps/polaris/scripts/polaris.ts`: unified TypeScript entrypoint for the Polaris app
- `scripts/operations/setup-k3s-sandbox-runtimes.sh`
- `scripts/operations/setup-k3s-kubevirt.sh`
- `scripts/operations/setup-k3s-kata-worker.sh`
- `scripts/operations/setup-k3s-cdi.sh`
- `scripts/operations/run-gvisor-smoke-test.sh`
- `scripts/operations/run-kata-smoke-test.sh`
- `scripts/operations/refresh-k3s-network.sh`
- `scripts/operations/reset-paseo-daemon.sh`
- `scripts/operations/render-morpheus-vm-cloudinit-secret.py`
- `scripts/tooling/workspace/install-nvim.sh`
- `scripts/tooling/workspace/install-tmux.sh`
- `scripts/tooling/workspace/install-zsh.sh`
- `scripts/tooling/host/install-alacritty.sh`

## Removed Legacy Scripts

The following personal environment setup scripts were removed because they are
not part of the current workspace orchestration path:

- legacy Python control-plane entrypoint
- `scripts/setup-alacritty.sh`
- `scripts/setup-nvim.sh`
- `scripts/setup-tmux.sh`
- `scripts/setup-zsh.sh`
