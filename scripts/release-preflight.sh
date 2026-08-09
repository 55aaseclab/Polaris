#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${1:-/etc/polaris/polaris.env}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

fail() {
  printf 'release preflight: %s\n' "$*" >&2
  exit 1
}

if [ ! -f "${ENV_FILE}" ]; then
  fail "environment file not found: ${ENV_FILE}"
fi

set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

release_gate_mode="${POLARIS_RELEASE_GATE_MODE:-production}"
case "${release_gate_mode}" in
  local-test|production) ;;
  *) fail "POLARIS_RELEASE_GATE_MODE must be local-test or production" ;;
esac
if [ "${release_gate_mode}" = "production" ]; then
  release_url_requirement="valid HTTPS URL"
  gateway_origin_requirement="bare HTTPS origin"
  allowed_origins_requirement="explicit HTTPS origins"
else
  release_url_requirement="valid release URL"
  gateway_origin_requirement="bare release origin"
  allowed_origins_requirement="explicit release origins"
fi

if ! release_profile_output="$(node "${SCRIPT_DIR}/release-profile.mjs" 2>&1)"; then
  printf '%s\n' "${release_profile_output}" >&2
  fail "release profile configuration is invalid"
fi

gateway_origin="${POLARIS_WANGHAI_GATEWAY_ORIGIN:-}"
docker_gateway_host="${POLARIS_WANGHAI_DOCKER_GATEWAY_HOST:-}"
master_secret="${POLARIS_WANGHAI_GATEWAY_MASTER_SECRET:-}"
wanghai_image="${POLARIS_WANGHAI_VAULT_IMAGE:-}"
workspace_base_image="${POLARIS_WORKSPACE_BASE_IMAGE:-}"
wanghai_cosign_identity="${POLARIS_WANGHAI_COSIGN_CERTIFICATE_IDENTITY:-}"
wanghai_cosign_oidc_issuer="${POLARIS_WANGHAI_COSIGN_CERTIFICATE_OIDC_ISSUER:-}"
allowed_origins="${POLARIS_PORTAL_ALLOWED_ORIGINS:-}"
auth_mode="${POLARIS_AUTH_MODE:-}"
backup_key_root="${POLARIS_WANGHAI_BACKUP_KEY_ROOT:-}"
backup_retention_count="${POLARIS_WANGHAI_BACKUP_RETENTION_COUNT:-}"
backup_timeout_ms="${POLARIS_WANGHAI_BACKUP_TIMEOUT_MS:-}"
backup_submissions_per_hour="${POLARIS_WANGHAI_BACKUP_SUBMISSIONS_PER_HOUR:-}"

if [ -n "${POLARIS_WANGHAI_DATA_ROOT:-}" ]; then
  fail "POLARIS_WANGHAI_DATA_ROOT must be unset; integrated Wanghai derives /vault/project"
fi

if [ "${docker_gateway_host}" != "127.0.0.1" ]; then
  fail "POLARIS_WANGHAI_DOCKER_GATEWAY_HOST must be 127.0.0.1 for the single-host Docker release"
fi

require_integer_range() {
  local value="$1" name="$2" minimum="$3" maximum="$4"
  if ! [[ "${value}" =~ ^[0-9]+$ ]] \
    || [ "${value}" -lt "${minimum}" ] \
    || [ "${value}" -gt "${maximum}" ]; then
    fail "${name} must be an integer between ${minimum} and ${maximum}"
  fi
}

# Production always requires Authing browser sessions. local-test may use
# disabled auth only for synthetic host smoke and capacity bring-up; restore
# Authing before any production gate.
if [ "${release_gate_mode}" = "production" ]; then
  if [ "${auth_mode}" != "authing-browser-session" ]; then
    fail "POLARIS_AUTH_MODE must be authing-browser-session for a production release"
  fi
elif [ "${auth_mode}" != "authing-browser-session" ] && [ "${auth_mode}" != "disabled" ]; then
  fail "POLARIS_AUTH_MODE must be authing-browser-session or disabled in local-test mode"
fi

if [ "${auth_mode}" = "disabled" ]; then
  printf 'release preflight: Authing disabled for local-test only; not a production candidate\n'
else
  for auth_key in \
    POLARIS_AUTHING_APP_ID \
    POLARIS_AUTHING_APP_SECRET \
    POLARIS_AUTHING_ISSUER \
    POLARIS_AUTHING_AUTHORIZATION_URL \
    POLARIS_AUTHING_TOKEN_URL \
    POLARIS_AUTHING_LOGOUT_URL \
    POLARIS_AUTHING_LOGOUT_REDIRECT_URI \
    POLARIS_AUTHING_REDIRECT_URI; do
    auth_value="${!auth_key:-}"
    if [ -z "${auth_value}" ] || [[ "${auth_value}" == *"replace-with"* || "${auth_value}" == your-* ]]; then
      fail "${auth_key} must be a real production value"
    fi
  done

  for auth_url_key in \
    POLARIS_AUTHING_ISSUER \
    POLARIS_AUTHING_AUTHORIZATION_URL \
    POLARIS_AUTHING_TOKEN_URL \
    POLARIS_AUTHING_LOGOUT_URL \
    POLARIS_AUTHING_LOGOUT_REDIRECT_URI \
    POLARIS_AUTHING_REDIRECT_URI; do
    auth_url="${!auth_url_key}"
    if ! node -e '
      const raw = process.argv[1] || "";
      let value;
      try {
        value = new URL(raw);
      } catch {
        process.exit(1);
      }
      const allowHttp = process.argv[2] === "1";
      if (((value.protocol !== "https:") && (!allowHttp || value.protocol !== "http:"))
        || value.username || value.password || !value.hostname
        || value.search || value.hash) process.exit(1);
    ' "${auth_url}" "$([ "${release_gate_mode}" = "local-test" ] && printf 1 || printf 0)"; then
      fail "${auth_url_key} must be a ${release_url_requirement}"
    fi
  done
fi

if [ "${#master_secret}" -lt 32 ] || [[ "${master_secret}" == *"replace-with"* ]]; then
  fail "POLARIS_WANGHAI_GATEWAY_MASTER_SECRET must be a non-placeholder value of at least 32 characters"
fi

if [ -z "${gateway_origin}" ]; then
  fail "POLARIS_WANGHAI_GATEWAY_ORIGIN is required"
fi

gateway_host="$(node -e '
const raw = process.argv[1] || "";
let origin;
try {
  origin = new URL(raw);
} catch {
  process.exit(1);
}
const allowHttp = process.argv[2] === "1";
if (((origin.protocol !== "https:") && (!allowHttp || origin.protocol !== "http:"))
  || origin.username || origin.password
  || origin.pathname !== "/" || origin.search || origin.hash || !origin.hostname) {
  process.exit(1);
}
process.stdout.write(origin.hostname.toLowerCase());
' "${gateway_origin}" "$([ "${release_gate_mode}" = "local-test" ] && printf 1 || printf 0)")" || fail "POLARIS_WANGHAI_GATEWAY_ORIGIN must be a ${gateway_origin_requirement}"

if [ -z "${allowed_origins}" ]; then
  fail "POLARIS_PORTAL_ALLOWED_ORIGINS is required"
fi
node -e '
const values = (process.argv[1] || "").split(",").map((value) => value.trim()).filter(Boolean);
const allowHttp = process.argv[2] === "1";
if (values.length === 0 || values.some((value) => value === "*")) process.exit(1);
for (const value of values) {
  const origin = new URL(value);
  if (((origin.protocol !== "https:") && (!allowHttp || origin.protocol !== "http:"))
    || origin.username || origin.password
    || origin.pathname !== "/" || origin.search || origin.hash) process.exit(1);
}
' "${allowed_origins}" "$([ "${release_gate_mode}" = "local-test" ] && printf 1 || printf 0)" || fail "POLARIS_PORTAL_ALLOWED_ORIGINS must contain ${allowed_origins_requirement}"

if ! node -e '
const gateway = new URL(process.argv[1]);
const values = (process.argv[2] || "").split(",").map((value) => value.trim()).filter(Boolean);
if (values.length !== 1 || values[0] !== gateway.origin) process.exit(1);
' "${gateway_origin}" "${allowed_origins}"; then
  fail "POLARIS_WANGHAI_GATEWAY_ORIGIN must be the only Polaris portal origin"
fi

if ! [[ "${wanghai_image}" =~ @sha256:[a-f0-9]{64}$ ]]; then
  fail "POLARIS_WANGHAI_VAULT_IMAGE must be a digest-pinned image reference"
fi

if ! [[ "${workspace_base_image}" =~ @sha256:[a-f0-9]{64}$ ]]; then
  fail "POLARIS_WORKSPACE_BASE_IMAGE must be a digest-pinned image reference"
fi

node "${SCRIPT_DIR}/release-manifest.mjs" "${ENV_FILE}" \
  || fail "release candidate manifest validation failed"

if [ "${release_gate_mode}" = "production" ]; then
for cosign_key in \
  POLARIS_WANGHAI_COSIGN_CERTIFICATE_IDENTITY \
  POLARIS_WANGHAI_COSIGN_CERTIFICATE_OIDC_ISSUER; do
  cosign_value="${!cosign_key:-}"
  if [ -z "${cosign_value}" ] || [[ "${cosign_value}" == *"replace-with"* ]]; then
    fail "${cosign_key} must be a real production value"
  fi
  if ! node -e '
    const raw = process.argv[1] || "";
    let value;
    try {
      value = new URL(raw);
    } catch {
      process.exit(1);
    }
    if (value.protocol !== "https:" || value.username || value.password || !value.hostname
      || value.search || value.hash) process.exit(1);
  ' "${cosign_value}"; then
    fail "${cosign_key} must be a valid HTTPS URL"
  fi
done

fi

if [ -z "${backup_key_root}" ] \
  || [[ "${backup_key_root}" != /* ]] \
  || [ ! -d "${backup_key_root}" ] \
  || [ -L "${backup_key_root}" ]; then
  fail "POLARIS_WANGHAI_BACKUP_KEY_ROOT must be an existing absolute non-symlink directory"
fi
backup_key_mode="$(stat -c '%a' "${backup_key_root}")" \
  || fail "unable to inspect POLARIS_WANGHAI_BACKUP_KEY_ROOT permissions"
if ! [[ "${backup_key_mode}" =~ ^[0-7]{3,4}$ ]] \
  || (( (8#${backup_key_mode} & 8#077) != 0 )); then
  fail "POLARIS_WANGHAI_BACKUP_KEY_ROOT must not be group/world accessible"
fi
require_integer_range "${backup_retention_count}" "POLARIS_WANGHAI_BACKUP_RETENTION_COUNT" 1 30
require_integer_range "${backup_timeout_ms}" "POLARIS_WANGHAI_BACKUP_TIMEOUT_MS" 60000 21600000
require_integer_range "${backup_submissions_per_hour}" "POLARIS_WANGHAI_BACKUP_SUBMISSIONS_PER_HOUR" 1 24

command -v docker >/dev/null 2>&1 || fail "docker is required for release preflight"
if ! docker image inspect "${wanghai_image}" >/dev/null 2>&1; then
  fail "digest-pinned Wanghai image is not present on the host"
fi

if [ "${release_gate_mode}" = "production" ]; then
command -v cosign >/dev/null 2>&1 || fail "cosign is required to verify the Wanghai image signature"
if ! cosign verify \
  --certificate-identity "${wanghai_cosign_identity}" \
  --certificate-oidc-issuer "${wanghai_cosign_oidc_issuer}" \
  "${wanghai_image}" >/dev/null; then
  fail "Wanghai image signature verification failed"
fi

verify_wanghai_attestation() {
  local predicate_type="$1" label="$2"
  if ! cosign verify-attestation \
    --type "${predicate_type}" \
    --certificate-identity "${wanghai_cosign_identity}" \
    --certificate-oidc-issuer "${wanghai_cosign_oidc_issuer}" \
    "${wanghai_image}" >/dev/null; then
    fail "${label} verification failed"
  fi
}

verify_wanghai_attestation "slsaprovenance" "Wanghai image provenance attestation"
verify_wanghai_attestation "spdxjson" "Wanghai image SBOM attestation"
else
  printf 'release preflight: external supply-chain verification skipped in local-test mode\n'
fi

command -v findmnt >/dev/null 2>&1 || fail "findmnt is required to validate Docker storage quotas"
docker_storage_driver="$(docker info --format '{{.Driver}}')" \
  || fail "unable to inspect Docker storage driver"
docker_root_dir="$(docker info --format '{{.DockerRootDir}}')" \
  || fail "unable to inspect Docker root directory"
docker_storage_mount="$(findmnt -T "${docker_root_dir}" -no FSTYPE,OPTIONS 2>/dev/null)" \
  || fail "unable to inspect the Docker root filesystem"
read -r docker_storage_fs docker_storage_options <<< "${docker_storage_mount}"
if [ "${docker_storage_driver}" != "overlay2" ] \
  || [ "${docker_storage_fs}" != "xfs" ] \
  || ! printf '%s' "${docker_storage_options}" | grep -Eq '(^|,)(pquota|prjquota)(,|$)'; then
  fail "Docker storage must be overlay2 on xfs with pquota or prjquota for hard writable-layer limits"
fi

docker_ports="$(docker ps --format '{{.Names}}\t{{.Ports}}')" \
  || fail "unable to inspect Docker port mappings"
if printf '%s\n' "${docker_ports}" \
  | grep -Eq '(^|[,[:space:]])(0\.0\.0\.0|:::|\[::\]):[0-9]+->9090/tcp'; then
  fail "a public Docker mapping to Wanghai port 9090 is still active"
fi

if [ "${release_gate_mode}" = "production" ]; then
  if ! getent ahosts "${gateway_host}" >/dev/null 2>&1; then
    fail "Polaris public DNS does not resolve"
  fi
  if ! curl --proto '=https' --tlsv1.2 --silent --show-error --output /dev/null \
    --connect-timeout 10 --max-time 20 "https://${gateway_host}/healthz"; then
    fail "Polaris public TLS endpoint is not reachable or does not validate"
  fi
else
  printf 'release preflight: external DNS and TLS verification skipped in local-test mode\n'
fi

printf 'release preflight: ok (%s)\n' "${release_gate_mode}"
