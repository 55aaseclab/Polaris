#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${1:-.env.deploy}"
PORTAL_PORT="${POLARIS_PORTAL_PORT:-8787}"
PORTAL_HOST="${POLARIS_PORTAL_HOST:-127.0.0.1}"
RUNTIME_DIR=".runtime"
PID_FILE="${RUNTIME_DIR}/polaris-server.pid"
LOG_FILE="${RUNTIME_DIR}/polaris-server.log"

if [ ! -f "${ENV_FILE}" ]; then
  echo "Missing env file: ${ENV_FILE}" >&2
  exit 1
fi

mkdir -p "${RUNTIME_DIR}"

set -a
. "${ENV_FILE}"
set +a

pnpm --filter polaris run build

if [ -f "${PID_FILE}" ]; then
  existing_pid="$(cat "${PID_FILE}" 2>/dev/null || true)"
  if [ -n "${existing_pid}" ] && kill -0 "${existing_pid}" 2>/dev/null; then
    kill "${existing_pid}" 2>/dev/null || true
    sleep 1
  fi
  rm -f "${PID_FILE}"
fi

nohup node apps/polaris/dist/scripts/polaris.js portal "${PORTAL_PORT}" "${PORTAL_HOST}" >"${LOG_FILE}" 2>&1 &
echo $! > "${PID_FILE}"

docker compose --env-file "${ENV_FILE}" up -d --build --remove-orphans paseo-app polaris-webportal nginx
