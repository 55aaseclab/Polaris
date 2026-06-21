FROM debian:13

ENV DEBIAN_FRONTEND=noninteractive
ENV PATH=/root/.local/polaris/bin:/root/.cargo/bin:${PATH}

RUN apt-get update && apt-get install -y \
  bash \
  build-essential \
  ca-certificates \
  curl \
  fd-find \
  git \
  jq \
  neovim \
  nodejs \
  npm \
  openssh-client \
  procps \
  python3 \
  ripgrep \
  tmux \
  wget \
  xdg-utils \
  zsh \
  && rm -rf /var/lib/apt/lists/*

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y

RUN mkdir -p /root/.local/polaris \
  /root/.npm \
  && npm install -g --prefix /root/.local/polaris \
    @getpaseo/cli@latest \
    @openai/codex \
    @anthropic-ai/claude-code \
    @fission-ai/openspec@latest \
    pnpm

RUN ln -sf /root/.local/polaris/bin/paseo /usr/local/bin/paseo \
  && ln -sf /root/.local/polaris/bin/pnpm /usr/local/bin/pnpm \
  && printf '%s\n' \
    '#!/usr/bin/env bash' \
    'set -euo pipefail' \
    'export CODEX_HOME=/root/.codex' \
    'export NPM_CONFIG_PREFIX=/root/.local/polaris' \
    'export npm_config_cache=/root/.npm' \
    'mkdir -p /root/.codex' \
    'exec /root/.local/polaris/bin/codex "$@"' \
    > /usr/local/bin/codex \
  && chmod 755 /usr/local/bin/codex \
  && printf '%s\n' \
    '#!/usr/bin/env bash' \
    'set -euo pipefail' \
    'export NPM_CONFIG_PREFIX=/root/.local/polaris' \
    'export npm_config_cache=/root/.npm' \
    'exec /root/.local/polaris/bin/claude "$@"' \
    > /usr/local/bin/claude \
  && chmod 755 /usr/local/bin/claude
