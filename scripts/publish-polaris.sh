#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${1:-.env.deploy}"

if [ ! -f "${ENV_FILE}" ]; then
  echo "Missing env file: ${ENV_FILE}" >&2
  exit 1
fi

set -a
. "${ENV_FILE}"
set +a

CPOLAR_HOSTNAME="${CPOLAR_HOSTNAME:-}"
CPOLAR_TARGET_PORT="${CPOLAR_TARGET_PORT:-}"
CPOLAR_TLS_CERT_PATH="${CPOLAR_TLS_CERT_PATH:-}"
CPOLAR_TLS_KEY_PATH="${CPOLAR_TLS_KEY_PATH:-}"

if [ -z "${CPOLAR_HOSTNAME}" ]; then
  echo "CPOLAR_HOSTNAME is required" >&2
  exit 1
fi

if [ -z "${CPOLAR_TARGET_PORT}" ]; then
  echo "CPOLAR_TARGET_PORT is required" >&2
  exit 1
fi

declare -a args
args=(http "-hostname=${CPOLAR_HOSTNAME}")

if [ -n "${CPOLAR_TLS_CERT_PATH}" ] || [ -n "${CPOLAR_TLS_KEY_PATH}" ]; then
  if [ -z "${CPOLAR_TLS_CERT_PATH}" ] || [ -z "${CPOLAR_TLS_KEY_PATH}" ]; then
    echo "CPOLAR_TLS_CERT_PATH and CPOLAR_TLS_KEY_PATH must be set together" >&2
    exit 1
  fi
  args+=(
    "-crt=${CPOLAR_TLS_CERT_PATH}"
    "-key=${CPOLAR_TLS_KEY_PATH}"
  )
fi

args+=("${CPOLAR_TARGET_PORT}")

exec cpolar "${args[@]}"
