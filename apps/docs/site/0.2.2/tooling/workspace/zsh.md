# Zsh

Zsh is optional workspace shell tooling for Polaris. It is intended to be
installed inside a workspace rather than treated as part of the core platform.

## Install

```bash
bash scripts/tooling/workspace/install-zsh.sh
```

The installer:

- installs `zsh`, `git`, and `curl`
- installs or updates `oh-my-zsh`
- installs:
  - `zsh-autosuggestions`
  - `zsh-syntax-highlighting`
- installs repo-managed shell config from:
  - `config/tooling/workspace/zsh/.zshrc`
  - `config/tooling/workspace/zsh/.zshenv`

## Scope

Zsh is optional workspace tooling, not part of the Polaris control plane.

It belongs with other in-workspace tools such as:

- Neovim
- tmux

and is separate from host-side companion tooling such as Alacritty.
