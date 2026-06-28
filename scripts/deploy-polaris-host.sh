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

pnpm --filter polaris run build

docker compose --env-file "${ENV_FILE}" up -d --build --remove-orphans paseo-app polaris-server polaris-webportal nginx

bash ./scripts/manage-polaris-executor-host.sh "${ENV_FILE}" restart
