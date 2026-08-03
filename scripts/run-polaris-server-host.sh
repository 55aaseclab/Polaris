#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
SERVER_PORT="${POLARIS_SERVER_PORT:-8787}"
SERVER_HOST="${POLARIS_SERVER_BIND_HOST:-127.0.0.1}"

exec "${NODE_BIN}" "${ROOT_DIR}/apps/polaris/dist/scripts/polaris.js" server \
  "${SERVER_PORT}" \
  "${SERVER_HOST}"
