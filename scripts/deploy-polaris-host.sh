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

EXECUTOR_PORT="${POLARIS_EXECUTOR_PORT:-8788}"
EXECUTOR_HOST="${POLARIS_EXECUTOR_HOST:-127.0.0.1}"

pnpm --filter polaris run build

docker compose --env-file "${ENV_FILE}" up -d --build --remove-orphans paseo-app polaris-server polaris-webportal nginx

exec node apps/polaris/dist/scripts/polaris.js executor "${EXECUTOR_PORT}" "${EXECUTOR_HOST}"
