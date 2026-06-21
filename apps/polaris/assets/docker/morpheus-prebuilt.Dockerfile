FROM debian:trixie-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV PATH=/root/.local/polaris/bin:/root/.cargo/bin:${PATH}

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

RUN mkdir -p /root/.local/polaris \
  && npm install -g --prefix /root/.local/polaris \
    @getpaseo/cli@latest \
    @openai/codex \
    @anthropic-ai/claude-code \
    @fission-ai/openspec@latest \
    pnpm

RUN ln -sf /root/.local/polaris/bin/paseo /usr/local/bin/paseo \
  && ln -sf /root/.local/polaris/bin/pnpm /usr/local/bin/pnpm \
  && printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' 'exec /root/.local/polaris/bin/codex "$@"' > /usr/local/bin/codex \
  && chmod 755 /usr/local/bin/codex \
  && printf '%s\n' '#!/usr/bin/env bash' 'set -euo pipefail' 'exec /root/.local/polaris/bin/claude "$@"' > /usr/local/bin/claude \
  && chmod 755 /usr/local/bin/claude
