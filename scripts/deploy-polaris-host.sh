#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${1:-.env.deploy}"

if [ ! -f "${ENV_FILE}" ]; then
  echo "Missing env file: ${ENV_FILE}" >&2
  exit 1
fi

set -a
. "${ENV_FILE}"
set +a
export POLARIS_ENV_FILE="${ENV_FILE}"
export POLARIS_SERVER_UID="${POLARIS_SERVER_UID:-$(id -u)}"
export POLARIS_SERVER_GID="${POLARIS_SERVER_GID:-$(id -g)}"

EXECUTOR_PORT="${POLARIS_EXECUTOR_PORT:-8788}"
EXECUTOR_HOST="${POLARIS_EXECUTOR_HOST:-127.0.0.1}"

resolve_docker_bridge_gateway() {
  docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null \
    || ip -4 addr show docker0 2>/dev/null | awk '/inet / {print $2}' | cut -d/ -f1 | head -n1
}

if printf '%s' "${POLARIS_EXECUTOR_BASE_URL:-}" | grep -Eq '^https?://host\.docker\.internal([/:]|$)' \
  && [ "${EXECUTOR_HOST}" = "127.0.0.1" ]; then
  DOCKER_BRIDGE_GATEWAY="$(resolve_docker_bridge_gateway || true)"
  if [ -n "${DOCKER_BRIDGE_GATEWAY}" ]; then
    EXECUTOR_HOST="${DOCKER_BRIDGE_GATEWAY}"
  fi
fi

pnpm --filter polaris run build

docker compose --env-file "${ENV_FILE}" up -d --build --remove-orphans paseo-app polaris-server polaris-webportal nginx

echo "Starting Polaris executor on http://${EXECUTOR_HOST}:${EXECUTOR_PORT}"
exec node apps/polaris/dist/scripts/polaris.js executor "${EXECUTOR_PORT}" "${EXECUTOR_HOST}"
