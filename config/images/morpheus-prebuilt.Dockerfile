FROM debian:trixie-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV PATH=/opt/agent-cli/bin:/root/.cargo/bin:${PATH}

RUN apt-get update && apt-get install -y \
  openssh-client \
  bash \
  bat \
  bubblewrap \
  build-essential \
  ca-certificates \
  curl \
  docker.io \
  fd-find \
  git \
  htop \
  jq \
  libasound2t64 \
  nodejs \
  npm \
  python3 \
  python3-pip \
  ripgrep \
  sudo \
  wget \
  xdg-utils \
  && rm -rf /var/lib/apt/lists/*

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y

RUN mkdir -p /opt/agent-cli \
  && npm install -g --prefix /opt/agent-cli \
    @getpaseo/cli@latest \
    @openai/codex \
    @anthropic-ai/claude-code \
    @fission-ai/openspec@latest \
    pnpm

RUN ln -sf /opt/agent-cli/bin/paseo /usr/local/bin/paseo \
  && ln -sf /opt/agent-cli/bin/pnpm /usr/local/bin/pnpm \
  && printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' 'exec /opt/agent-cli/bin/codex "$@"' > /usr/local/bin/codex \
  && chmod 755 /usr/local/bin/codex \
  && printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' 'exec /opt/agent-cli/bin/claude "$@"' > /usr/local/bin/claude \
  && chmod 755 /usr/local/bin/claude
