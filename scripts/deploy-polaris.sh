#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${1:-/etc/polaris/polaris.env}"
ACTIVE_COLOR_FILE="${2:-/etc/polaris/active-color}"
UPSTREAM_FILE="${3:-/etc/nginx/snippets/polaris-gateway-upstream.conf}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${ROOT_DIR}/deploy/docker-compose.polaris-bluegreen.yml"

# shellcheck disable=SC1091
source "${ROOT_DIR}/scripts/lib/polaris-bluegreen.sh"

cd "${ROOT_DIR}"

polaris_bluegreen_require_env_file "${ENV_FILE}"

set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a
export POLARIS_ENV_FILE="${ENV_FILE}"
export POLARIS_SERVER_UID="${POLARIS_SERVER_UID:-$(id -u)}"
export POLARIS_SERVER_GID="${POLARIS_SERVER_GID:-$(id -g)}"

active_color="$(polaris_bluegreen_active_color "${ACTIVE_COLOR_FILE}")"
target_color="$(polaris_bluegreen_inactive_color "${active_color}")"
project_name="$(polaris_bluegreen_project_name "${target_color}")"
target_port="$(polaris_bluegreen_nginx_port "${target_color}")"
temp_env="$(mktemp)"

trap 'rm -f "${temp_env}"' EXIT

polaris_bluegreen_write_temp_env "${ENV_FILE}" "${target_color}" "${temp_env}"

set -a
# shellcheck disable=SC1090
source "${temp_env}"
set +a

pnpm install --frozen-lockfile
pnpm --filter polaris run build

docker compose -f "${COMPOSE_FILE}" -p "${project_name}" --env-file "${temp_env}" up -d --build

polaris_bluegreen_wait_for_stack "${target_port}"
polaris_bluegreen_switch_upstream "${target_color}" "${UPSTREAM_FILE}" "${ACTIVE_COLOR_FILE}"

echo "active_color=${target_color}"
echo "project=${project_name}"
echo "port=${target_port}"
