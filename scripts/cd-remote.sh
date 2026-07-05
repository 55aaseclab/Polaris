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
REMOTE_UPSTREAM_FILE="/etc/nginx/snippets/polaris-gateway-upstream.conf"
RSYNC_RSH="${RSYNC_RSH:-ssh}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "${ROOT_DIR}"

bash ./scripts/ci-local.sh
bash ./scripts/build-paseo-tool-bundle.sh
bash ./scripts/build-paseo-web-artifact.sh

ssh "${REMOTE_HOST}" "mkdir -p '${REMOTE_APP_DIR}'"

rsync -az --delete \
  --include "apps/paseo/tool-bundle/" \
  --include "apps/paseo/tool-bundle/bin/***" \
  --include "apps/paseo/tool-bundle/lib/" \
  --include "apps/paseo/tool-bundle/lib/node_modules/***" \
  --exclude ".git" \
  --exclude "node_modules" \
  --exclude "dist" \
  --exclude ".runtime" \
  --exclude ".pnpm-store" \
  --exclude ".tmp" \
  --exclude ".venv" \
  --exclude ".cert" \
  --exclude ".env.dev" \
  --exclude ".env.test" \
  --exclude ".env.prod" \
  --exclude "test-results" \
  --exclude "config/exports" \
  --exclude "config/generated" \
  --include "config/users/" \
  --include "config/users/user-map.example.json" \
  --include "config/users/profiles/" \
  --include "config/users/profiles/100000000000000001.yaml" \
  --include "config/users/100000000000000001/" \
  --include "config/users/100000000000000001/.gitignore" \
  --exclude "config/users/*/**" \
  --exclude "config/users/*" \
  --exclude "config/state" \
  -e "${RSYNC_RSH}" \
  ./ "${REMOTE_HOST}:${REMOTE_APP_DIR}/"

ssh "${REMOTE_HOST}" "cd '${REMOTE_APP_DIR}' && bash ./scripts/deploy-polaris.sh '${REMOTE_ENV_FILE}' '${REMOTE_ACTIVE_COLOR_FILE}' '${REMOTE_UPSTREAM_FILE}'"
