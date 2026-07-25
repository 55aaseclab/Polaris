#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "${ROOT_DIR}"

echo "[1/8] typecheck"
pnpm run check

echo "[2/8] polaris skill tests"
pnpm run test:polaris:skills

echo "[3/9] polaris non-infra regression tests"
pnpm --filter polaris run test:full-minus-infra

echo "[4/9] build polaris"
pnpm --filter polaris run build

echo "[5/8] shell syntax checks"
bash -n scripts/run-polaris-local-stack-service.sh
bash -n scripts/ci-local.sh
bash -n scripts/provision-remote.sh
bash -n scripts/cd-remote.sh
bash -n scripts/rollback-remote.sh
bash -n scripts/build-paseo-web-artifact.sh
bash -n scripts/build-paseo-tool-bundle.sh
bash -n scripts/clean-paseo-web-artifact.sh
bash -n scripts/deploy-polaris.sh
bash -n scripts/rollback-polaris.sh
bash -n scripts/lib/polaris-bluegreen.sh
bash -n scripts/lib/polaris-deploy-restart.sh
bash -n scripts/lib/paseo-local.sh

echo "[6/8] local stack regression tests"
node --test scripts/tests/local-stack-service.test.mjs
node --test scripts/tests/deploy-polaris-restart.test.mjs

echo "[7/8] docker compose config"
docker compose -f deploy/docker-compose.polaris-bluegreen.yml --env-file .env.prod.example config --services >/dev/null

echo "[8/8] paseo artifact verification"
bash ./scripts/build-paseo-tool-bundle.sh >/dev/null
(
  set -a
  if [ -f ./.env.prod ]; then
    # shellcheck disable=SC1091
    . ./.env.prod
  else
    # shellcheck disable=SC1091
    . ./.env.prod.example
  fi
  set +a
  bash ./scripts/build-paseo-web-artifact.sh >/dev/null
)

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
