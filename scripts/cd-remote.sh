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
RELEASE_MANIFEST_SOURCE="${RELEASE_MANIFEST_SOURCE:-${ROOT_DIR}/deploy/release-manifest.json}"

cd "${ROOT_DIR}"

bash ./scripts/ci-local.sh
bash ./scripts/build-paseo-tool-bundle.sh
(
  set -a
  # shellcheck disable=SC1091
  . ./.env.prod
  set +a
  bash ./scripts/build-paseo-web-artifact.sh
)

ssh "${REMOTE_HOST}" "mkdir -p '${REMOTE_APP_DIR}'"

rsync -azc --delete --one-file-system \
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
  --exclude "config/state" \
  --exclude "data" \
  --exclude "data/***" \
  --exclude "docker-root" \
  --exclude "docker-root/***" \
  --exclude "deploy/release-manifest.json" \
  -e "${RSYNC_RSH}" \
  ./ "${REMOTE_HOST}:${REMOTE_APP_DIR}/"

if [ -f "${RELEASE_MANIFEST_SOURCE}" ]; then
  rsync -az \
    -e "${RSYNC_RSH}" \
    "${RELEASE_MANIFEST_SOURCE}" \
    "${REMOTE_HOST}:${REMOTE_APP_DIR}/deploy/release-manifest.json"
fi

ssh "${REMOTE_HOST}" "cd '${REMOTE_APP_DIR}' && bash ./scripts/deploy-polaris.sh '${REMOTE_ENV_FILE}' '${REMOTE_ACTIVE_COLOR_FILE}' '${REMOTE_UPSTREAM_FILE}'"
