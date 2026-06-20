#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${REPO_ROOT}/docker/morpheus-compose.yaml"

DEFAULT_MORPHEUS_ROOT_DIR="/var/lib/kubelet/plugins/kubernetes.io/csi/driver.longhorn.io/083db50c9d2e0df8f14538d0b1861805375f1344a8ce178164e56a34af938d14/globalmount"
export MORPHEUS_ROOT_DIR="${MORPHEUS_ROOT_DIR:-$DEFAULT_MORPHEUS_ROOT_DIR}"
export MORPHEUS_SECRETS_DIR="${MORPHEUS_SECRETS_DIR:-${REPO_ROOT}/secrets/agentctl}"

if [[ ! -d "${MORPHEUS_SECRETS_DIR}" ]]; then
  echo "MORPHEUS_SECRETS_DIR does not exist: ${MORPHEUS_SECRETS_DIR}" >&2
  exit 1
fi

docker compose -f "${COMPOSE_FILE}" up -d

echo
echo "Docker Morpheus started."
echo "Root dir: ${MORPHEUS_ROOT_DIR}"
echo "Ports: 31677->6767, 31678->8080, 31679->8081"
echo
echo "Pair link:"
docker exec morpheus-docker cat /root/.paseo/pairing.json
