#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" = "" ]; then
  echo "Usage: $0 <remote-host> [target-color] [remote-app-dir] [remote-env-file] [remote-active-color-file] [remote-upstream-file]" >&2
  exit 1
fi

REMOTE_HOST="$1"
TARGET_COLOR="${2:-}"
REMOTE_APP_DIR="${3:-/srv/polaris/app}"
REMOTE_ENV_FILE="${4:-/etc/polaris/polaris.env}"
REMOTE_ACTIVE_COLOR_FILE="${5:-/etc/polaris/active-color}"
REMOTE_UPSTREAM_FILE="${6:-/etc/nginx/conf.d/polaris-gateway-upstream.conf}"

if [ -n "${TARGET_COLOR}" ]; then
  TARGET_COLOR_ARG="'${TARGET_COLOR}'"
else
  TARGET_COLOR_ARG="''"
fi

ssh "${REMOTE_HOST}" "cd '${REMOTE_APP_DIR}' && bash ./scripts/rollback-polaris.sh '${REMOTE_ENV_FILE}' ${TARGET_COLOR_ARG} '${REMOTE_ACTIVE_COLOR_FILE}' '${REMOTE_UPSTREAM_FILE}'"
