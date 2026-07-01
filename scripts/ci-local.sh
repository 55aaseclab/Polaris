#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "${ROOT_DIR}"

echo "[1/5] typecheck"
pnpm run check

echo "[2/5] build polaris"
pnpm --filter polaris run build

echo "[3/5] build polaris-web"
pnpm --filter polaris-web run build

echo "[4/5] shell syntax checks"
bash -n scripts/run-polaris-local-stack-service.sh
bash -n scripts/ci-local.sh
bash -n scripts/provision-remote.sh
bash -n scripts/cd-remote.sh
bash -n scripts/rollback-remote.sh
bash -n scripts/build-paseo-web-artifact.sh
bash -n scripts/clean-paseo-web-artifact.sh
bash -n scripts/deploy-polaris.sh
bash -n scripts/rollback-polaris.sh
bash -n scripts/lib/polaris-bluegreen.sh
bash -n scripts/lib/paseo-local.sh

echo "[5/5] docker compose config"
docker compose -f deploy/docker-compose.polaris-bluegreen.yml --env-file .env.prod.example config --services >/dev/null

temp_blue_env="$(mktemp)"
temp_green_env="$(mktemp)"
trap 'rm -f "${temp_blue_env}" "${temp_green_env}"' EXIT

# shellcheck disable=SC1091
source "${ROOT_DIR}/scripts/lib/polaris-bluegreen.sh"
polaris_bluegreen_write_temp_env .env.prod.example blue "${temp_blue_env}"
polaris_bluegreen_write_temp_env .env.prod.example green "${temp_green_env}"
docker compose -f deploy/docker-compose.polaris-bluegreen.yml -p polaris-blue --env-file "${temp_blue_env}" config --services >/dev/null
docker compose -f deploy/docker-compose.polaris-bluegreen.yml -p polaris-green --env-file "${temp_green_env}" config --services >/dev/null

echo "ci-local: ok"
