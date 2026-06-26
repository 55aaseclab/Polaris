#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${1:-.env.deploy}"
PORTAL_PORT="${POLARIS_PORTAL_PORT:-8787}"
PORTAL_HOST="${POLARIS_PORTAL_HOST:-127.0.0.1}"

if [ ! -f "${ENV_FILE}" ]; then
  echo "Missing env file: ${ENV_FILE}" >&2
  exit 1
fi

set -a
. "${ENV_FILE}"
set +a
export POLARIS_ENV_FILE="${ENV_FILE}"

pnpm --filter polaris run build

docker compose --env-file "${ENV_FILE}" up -d --build --remove-orphans paseo-app polaris-webportal nginx

exec node apps/polaris/dist/scripts/polaris.js portal "${PORTAL_PORT}" "${PORTAL_HOST}"
