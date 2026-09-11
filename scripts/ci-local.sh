#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "${ROOT_DIR}"

echo "[1/10] typecheck"
pnpm run check

echo "[2/10] polaris skill tests"
pnpm run test:polaris:skills

echo "[3/10] polaris non-infra regression tests"
pnpm --filter polaris run test:full-minus-infra

echo "[4/10] build polaris"
pnpm --filter polaris run build

echo "[5/10] tool env precheck"
if [ -f ./.env.dev ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env.dev
  set +a
fi
pnpm --filter polaris exec tsx scripts/polaris.ts ops tool-precheck --json

echo "[6/10] common tool unit tests"
python3 -m unittest discover -s tools/crossref/tests -p 'test_*.py'
python3 -m unittest discover -s tools/semantic-scholar/tests -p 'test_*.py'
python3 -m unittest discover -s tools/deepsec/tests -p 'test_*.py'
python3 -m unittest discover -s tools/codex/tests -p 'test_*.py'
python3 -m unittest discover -s tools/data-collection/tests -p 'test_*.py'
python3 -m unittest discover -s tools/collection-review/tests -p 'test_*.py'
python3 -m unittest discover -s tools/analysis-review/tests -p 'test_*.py'
python3 -m unittest discover -s tools/intelligence-analysis/tests -p 'test_*.py'
python3 -m unittest discover -s tools/intelligence-analysis/literature-review/tests -p 'test_*.py'
python3 -m unittest discover -s tools/report-writing/tests -p 'test_*.py'
python3 -m unittest discover -s tools/social-media/tests -p 'test_*.py'
python3 -m unittest discover -s tools/image-review/tests -p 'test_*.py'
python3 -m unittest discover -s tools/video-review/tests -p 'test_*.py'
python3 -m unittest discover -s tools/outreach/tests -p 'test_*.py'
python3 -m unittest discover -s tools/social-publish/tests -p 'test_*.py'
node --test tools/browser/tests/runner.test.mjs

echo "[7/10] shell syntax checks"
bash -n scripts/run-polaris-local-stack-service.sh
bash -n scripts/ci-local.sh
bash -n scripts/provision-remote.sh
bash -n scripts/cd-remote.sh
bash -n scripts/rollback-remote.sh
bash -n scripts/install-local-container-runtime-cleanup.sh
bash -n scripts/cleanup-remote-container-runtime.sh
bash -n scripts/build-paseo-web-artifact.sh
bash -n scripts/build-paseo-tool-bundle.sh
bash -n scripts/clean-paseo-web-artifact.sh
bash -n scripts/deploy-polaris.sh
bash -n scripts/release-preflight.sh
bash -n scripts/provision-docker-storage-root.sh
bash -n scripts/rollback-polaris.sh
bash -n scripts/run-polaris-server-host.sh
bash -n scripts/lib/polaris-bluegreen.sh
bash -n scripts/lib/paseo-local.sh

echo "[8/10] local stack regression tests"
node --test scripts/tests/local-stack-service.test.mjs
node --test scripts/tests/sidecar-removal.test.mjs
node --test scripts/tests/remote-host-deploy.test.mjs
node --test scripts/tests/release-profile.test.mjs
node --test scripts/tests/release-preflight.test.mjs
node --test scripts/tests/release-manifest.test.mjs
node --test scripts/tests/create-release-manifest.test.mjs
node --test scripts/tests/capacity-gateway-load.test.mjs
node --test scripts/tests/docker-storage-root.test.mjs
node --test scripts/tests/paseo-local.test.mjs
node --test scripts/tests/workspace-base-image-workflow.test.mjs

echo "[9/10] docker compose config"
docker compose -f deploy/docker-compose.polaris-bluegreen.yml --env-file .env.prod.example config --services >/dev/null

echo "[10/10] paseo artifact verification"
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
