#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_BIN_DIR="${HOME}/.local/bin"
TARGET_LOG_DIR="${HOME}/.local/state/polaris"
TARGET_SCRIPT="${TARGET_BIN_DIR}/polaris-container-runtime-cleanup"
CRON_MARKER="# Polaris container runtime cleanup"
CRON_LINE="40 4 * * * PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=${HOME} LEASE_RETENTION_HOURS=24 DOCKER_PRUNE_UNTIL=24h ${TARGET_SCRIPT} >> ${TARGET_LOG_DIR}/container-runtime-cleanup.log 2>&1"

mkdir -p "${TARGET_BIN_DIR}" "${TARGET_LOG_DIR}"
install -m 755 "${ROOT_DIR}/scripts/cleanup-remote-container-runtime.sh" "${TARGET_SCRIPT}"

tmp_cron="$(mktemp)"
trap 'rm -f "${tmp_cron}"' EXIT

{
  crontab -l 2>/dev/null | grep -v -e '^# Polaris container runtime cleanup$' -e 'polaris-container-runtime-cleanup' || true
  printf '%s\n' "${CRON_MARKER}"
  printf '%s\n' "${CRON_LINE}"
} > "${tmp_cron}"

crontab "${tmp_cron}"

"${TARGET_SCRIPT}"

printf 'Installed local cleanup: %s\n' "${TARGET_SCRIPT}"
printf 'Cron entry: %s\n' "${CRON_LINE}"
