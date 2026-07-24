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

SERVER_HOST="${POLARIS_SERVER_BIND_HOST:-127.0.0.1}"
SERVER_PORT="${POLARIS_SERVER_PORT:-8787}"
EXECUTOR_HOST="${POLARIS_EXECUTOR_HOST:-127.0.0.1}"
EXECUTOR_PORT="${POLARIS_EXECUTOR_PORT:-8788}"
PASEO_HOST="${POLARIS_PASEO_APP_BIND_HOST:-127.0.0.1}"
PASEO_PORT="${POLARIS_PASEO_APP_PORT:-8082}"
LANDING_HOST="${POLARIS_LANDING_PAGE_BIND_HOST:-0.0.0.0}"
LANDING_PORT="${POLARIS_LANDING_PAGE_PORT:-5173}"
DOCS_HOST="${POLARIS_DOCS_BIND_HOST:-0.0.0.0}"
DOCS_PORT="${POLARIS_DOCS_PORT:-4180}"
LOG_DIR=".runtime/paseo"

mkdir -p "${LOG_DIR}"

cleanup() {
  local pids=(
    "${server_pid:-}"
    "${executor_pid:-}"
    "${executor_bridge_proxy_pid:-}"
    "${paseo_pid:-}"
    "${landing_pid:-}"
    "${docs_pid:-}"
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
paseo_local_ensure_source
if [ ! -d "apps/paseo/source/node_modules" ]; then
  (cd apps/paseo/source && npm ci --ignore-scripts)
fi
if [ ! -f "apps/paseo/source/packages/highlight/dist/index.js" ] \
  || [ ! -f "apps/paseo/source/packages/protocol/dist/messages.js" ] \
  || [ ! -f "apps/paseo/source/packages/client/dist/daemon-client.js" ]; then
  (cd apps/paseo/source && npm run build:app-deps)
fi

POLARIS_API_PROXY_TARGET="http://${SERVER_HOST}:${SERVER_PORT}" \
pnpm --filter polaris exec tsx watch scripts/polaris.ts server "${SERVER_PORT}" "${SERVER_HOST}" \
  > >(tee "${LOG_DIR}/stack.server.log") \
  2> >(tee "${LOG_DIR}/stack.server.err.log" >&2) &
server_pid=$!

pnpm --filter polaris exec tsx watch scripts/polaris.ts executor "${EXECUTOR_PORT}" "${EXECUTOR_HOST}" \
  > >(tee "${LOG_DIR}/stack.executor.log") \
  2> >(tee "${LOG_DIR}/stack.executor.err.log" >&2) &
executor_pid=$!

if command -v socat >/dev/null 2>&1 && ip -4 addr show docker0 >/dev/null 2>&1; then
  bash "${ROOT_DIR}/scripts/run-polaris-executor-bridge-proxy.sh" \
    > >(tee "${LOG_DIR}/stack.executor-bridge.log") \
    2> >(tee "${LOG_DIR}/stack.executor-bridge.err.log" >&2) &
  executor_bridge_proxy_pid=$!
else
  echo "[polaris-local-stack] executor bridge proxy not started; docker workspaces may not report Paseo pairing metadata back to the host executor" >&2
fi

(
  cd apps/paseo/source/packages/app
  EXPO_NO_TELEMETRY=1 \
  EXPO_PUBLIC_POLARIS_API_PORT="${SERVER_PORT}" \
  npx expo start --web --host lan --port "${PASEO_PORT}"
) \
  > >(tee "${LOG_DIR}/stack.paseo.log") \
  2> >(tee "${LOG_DIR}/stack.paseo.err.log" >&2) &
paseo_pid=$!

VITE_PASEO_APP_BASE_URL="${VITE_PASEO_APP_BASE_URL:-${POLARIS_PASEO_APP_BASE_URL}}" \
pnpm --filter landing-page exec vite \
  --host "${LANDING_HOST}" \
  --port "${LANDING_PORT}" \
  --strictPort \
  > >(tee "${LOG_DIR}/stack.landing.log") \
  2> >(tee "${LOG_DIR}/stack.landing.err.log" >&2) &
landing_pid=$!

pnpm --filter docs-viewer run predev
pnpm --filter docs-viewer exec vitepress dev site \
  --host "${DOCS_HOST}" \
  --port "${DOCS_PORT}" \
  --strictPort \
  > >(tee "${LOG_DIR}/stack.docs.log") \
  2> >(tee "${LOG_DIR}/stack.docs.err.log" >&2) &
docs_pid=$!

pids=(
  "${server_pid}"
  "${executor_pid}"
  "${paseo_pid}"
  "${landing_pid}"
  "${docs_pid}"
)
if [ -n "${executor_bridge_proxy_pid:-}" ]; then
  pids+=("${executor_bridge_proxy_pid}")
fi

wait -n "${pids[@]}"
exit 1
