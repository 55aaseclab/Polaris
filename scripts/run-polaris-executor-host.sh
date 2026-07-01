#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${1:-/etc/polaris/polaris.env}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ ! -f "${ENV_FILE}" ]; then
  echo "Missing env file: ${ENV_FILE}" >&2
  exit 1
fi

cd "${ROOT_DIR}"

set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

export POLARIS_ENV_FILE="${ENV_FILE}"
export POLARIS_EXECUTOR_HOST="127.0.0.1"
export POLARIS_EXECUTOR_PORT="${POLARIS_EXECUTOR_PORT:-8788}"

pnpm install --frozen-lockfile
pnpm --filter polaris run build

exec node apps/polaris/dist/scripts/polaris.js executor "${POLARIS_EXECUTOR_PORT}" "${POLARIS_EXECUTOR_HOST}"
