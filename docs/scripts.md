# Scripts

## Active Scripts

- `scripts/agentctl.ts`: unified TypeScript entrypoint
- `scripts/run-gvisor-smoke-test.sh`
- `scripts/run-kata-smoke-test.sh`
- `scripts/run-morpheus-docker.sh`
- `scripts/setup-k3s-kata-gvisor.sh`
- `scripts/setup-k3s-kata-worker.sh`
- `scripts/setup-k3s-kubevirt.sh`
- `scripts/setup-k3s-cdi.sh`
- `scripts/refresh-k3s-network.sh`
- `scripts/reset-paseo-daemon.sh`
- `scripts/render-headlamp-basic-auth-secret.sh`
- `scripts/render-morpheus-vm-cloudinit-secret.py`

## Removed Legacy Scripts

The following personal environment setup scripts were removed because they are
not part of the current workspace orchestration path:

- `scripts/agentctl.py`
- `scripts/setup-alacritty.sh`
- `scripts/setup-nvim.sh`
- `scripts/setup-tmux.sh`
- `scripts/setup-zsh.sh`

Their associated config files still exist under `config/` and their old
root-level documentation still exists for reference.
