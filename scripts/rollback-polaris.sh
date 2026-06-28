#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${1:-/etc/polaris/polaris.env}"
TARGET_COLOR="${2:-}"
ACTIVE_COLOR_FILE="${3:-/etc/polaris/active-color}"
UPSTREAM_FILE="${4:-/etc/nginx/conf.d/polaris-gateway-upstream.conf}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# shellcheck disable=SC1091
source "${ROOT_DIR}/scripts/lib/polaris-bluegreen.sh"

cd "${ROOT_DIR}"

polaris_bluegreen_require_env_file "${ENV_FILE}"

active_color="$(polaris_bluegreen_active_color "${ACTIVE_COLOR_FILE}")"

if [ -z "${TARGET_COLOR}" ]; then
  TARGET_COLOR="$(polaris_bluegreen_inactive_color "${active_color}")"
fi

case "${TARGET_COLOR}" in
  blue|green)
    ;;
  *)
    echo "Usage: $0 [env-file] [blue|green] [active-color-file] [upstream-file]" >&2
    exit 1
    ;;
esac

target_port="$(polaris_bluegreen_nginx_port "${TARGET_COLOR}")"
polaris_bluegreen_wait_for_stack "${target_port}"
polaris_bluegreen_switch_upstream "${TARGET_COLOR}" "${UPSTREAM_FILE}" "${ACTIVE_COLOR_FILE}"

echo "active_color=${TARGET_COLOR}"
echo "port=${target_port}"
