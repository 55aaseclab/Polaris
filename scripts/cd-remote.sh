#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" = "" ]; then
  echo "Usage: $0 <remote-host> [remote-app-dir] [remote-env-file]" >&2
  exit 1
fi

REMOTE_HOST="$1"
REMOTE_APP_DIR="${2:-/srv/polaris/app}"
REMOTE_ENV_FILE="${3:-/etc/polaris/polaris.env}"
REMOTE_ACTIVE_COLOR_FILE="/etc/polaris/active-color"
REMOTE_UPSTREAM_FILE="/etc/nginx/conf.d/polaris-gateway-upstream.conf"
RSYNC_RSH="${RSYNC_RSH:-ssh}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "${ROOT_DIR}"

bash ./scripts/ci-local.sh

ssh "${REMOTE_HOST}" "mkdir -p '${REMOTE_APP_DIR}'"

rsync -az --delete \
  --exclude ".git" \
  --exclude "node_modules" \
  --exclude "dist" \
  --exclude ".runtime" \
  --exclude ".pnpm-store" \
  --exclude ".tmp" \
  --exclude ".venv" \
  --exclude ".cert" \
  --exclude ".env.dev" \
  --exclude ".env.prod" \
  --exclude "config/users" \
  --exclude "config/state" \
  -e "${RSYNC_RSH}" \
  ./ "${REMOTE_HOST}:${REMOTE_APP_DIR}/"

ssh "${REMOTE_HOST}" "cd '${REMOTE_APP_DIR}' && bash ./scripts/deploy-polaris.sh '${REMOTE_ENV_FILE}' '${REMOTE_ACTIVE_COLOR_FILE}' '${REMOTE_UPSTREAM_FILE}'"
