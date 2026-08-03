#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${1:-.env.dev}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ ! -f "${ENV_FILE}" ]; then
  echo "Missing env file: ${ENV_FILE}" >&2
  exit 1
fi

cd "${ROOT_DIR}"

# shellcheck disable=SC1091
source "${ROOT_DIR}/scripts/lib/paseo-local.sh"

set -a
. "${ENV_FILE}"
set +a

# Outer control-plane auth (paseo-web / polaris-shell). Disabled = local default user.
# Product flavor (coding vs vertical) is per-user, not a deploy env — one stack serves all.
POLARIS_AUTH_MODE="${POLARIS_AUTH_MODE:-disabled}"
POLARIS_AUTH_DEFAULT_USER_ID="${POLARIS_AUTH_DEFAULT_USER_ID:-100000000000000001}"
export POLARIS_AUTH_MODE
export POLARIS_AUTH_DEFAULT_USER_ID

SERVER_HOST="${POLARIS_SERVER_BIND_HOST:-0.0.0.0}"
SERVER_PORT="${POLARIS_SERVER_PORT:-8787}"
# paseo-web runs OUTSIDE vault containers (shared coding UI capability).
# Expo `--host lan` already exposes it beyond loopback.
PASEO_PORT="${POLARIS_PASEO_APP_PORT:-8082}"
LOG_DIR=".runtime/paseo"

mkdir -p "${LOG_DIR}"

cleanup() {
  local pids=(
    "${server_pid:-}"
    "${paseo_pid:-}"
  )
  local pid
  for pid in "${pids[@]}"; do
    if [ -n "${pid}" ] && kill -0 "${pid}" 2>/dev/null; then
      kill "${pid}" 2>/dev/null || true
    fi
  done
  wait || true
}

trap cleanup EXIT INT TERM

pnpm install
pnpm --filter @qingniao/polaris-auth-server run build
# Build the shell bundle and the two surface packages before starting the stack.
pnpm run build:surfaces

paseo_local_ensure_source
if [ ! -d "apps/paseo/source/node_modules" ]; then
  (cd apps/paseo/source && npm ci --ignore-scripts)
fi
if [ ! -f "apps/paseo/source/packages/highlight/dist/index.js" ] \
  || [ ! -f "apps/paseo/source/packages/protocol/dist/messages.js" ] \
  || [ ! -f "apps/paseo/source/packages/client/dist/daemon-client.js" ]; then
  (cd apps/paseo/source && npm run build:app-deps)
fi

echo "[polaris-local-stack] auth_mode=${POLARIS_AUTH_MODE}" >&2
echo "[polaris-local-stack] outer: polaris API :${SERVER_PORT}, paseo-web :${PASEO_PORT}" >&2
echo "[polaris-local-stack] in-container (per vault): paseo daemon :6767; vertical vaults also wanghai portal :9090" >&2

POLARIS_API_PROXY_TARGET="http://${SERVER_HOST}:${SERVER_PORT}" \
pnpm --filter polaris exec tsx watch scripts/polaris.ts server "${SERVER_PORT}" "${SERVER_HOST}" \
  > >(tee "${LOG_DIR}/stack.server.log") \
  2> >(tee "${LOG_DIR}/stack.server.err.log" >&2) &
server_pid=$!

# Outer shared coding UI. It owns /h/... only; polaris-shell is served by the
# Polaris control plane on the outer shell routes.
(
  cd apps/paseo/source/packages/app
  EXPO_NO_TELEMETRY=1 \
  EXPO_PUBLIC_POLARIS_API_PORT="${SERVER_PORT}" \
  EXPO_PUBLIC_POLARIS_AUTH_MODE="${POLARIS_AUTH_MODE}" \
  EXPO_PUBLIC_POLARIS_AUTH_DEFAULT_USER_ID="${POLARIS_AUTH_DEFAULT_USER_ID}" \
  npx expo start --web --host lan --port "${PASEO_PORT}"
) \
  > >(tee "${LOG_DIR}/stack.paseo.log") \
  2> >(tee "${LOG_DIR}/stack.paseo.err.log" >&2) &
paseo_pid=$!

pids=(
  "${server_pid}"
  "${paseo_pid}"
)

wait -n "${pids[@]}"
exit 1
