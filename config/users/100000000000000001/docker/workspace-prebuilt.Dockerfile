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
  gnupg \
  jq \
  neovim \
  openssh-client \
  procps \
  python3 \
  ripgrep \
  tmux \
  wget \
  xdg-utils \
  zsh \
  && mkdir -p /etc/apt/keyrings /etc/apt/sources.list.d \
  && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor --batch --yes --no-tty -o /etc/apt/keyrings/nodesource.gpg \
  && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list \
  && apt-get update \
  && apt-get install -y nodejs \
  && rm -rf /var/lib/apt/lists/*

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y

RUN mkdir -p /root/.local/polaris \
  /root/.npm \
  && npm install -g --prefix /root/.local/polaris \
    @getpaseo/cli@latest \
    @openai/codex \
    @anthropic-ai/claude-code \
    @github/copilot \
    opencode-ai \
    @earendil-works/pi-coding-agent \
    @fission-ai/openspec@latest \
    pnpm

RUN ln -sf /root/.local/polaris/bin/paseo /usr/local/bin/paseo \
  && ln -sf /root/.local/polaris/bin/pnpm /usr/local/bin/pnpm \
  && ln -sf /root/.local/polaris/bin/copilot /usr/local/bin/copilot \
  && ln -sf /root/.local/polaris/bin/opencode /usr/local/bin/opencode \
  && ln -sf /root/.local/polaris/bin/pi /usr/local/bin/pi \
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
