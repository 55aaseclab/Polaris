#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${1:-/etc/polaris/polaris.env}"

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

gateway_origin="${POLARIS_WANGHAI_GATEWAY_ORIGIN:-}"
master_secret="${POLARIS_WANGHAI_GATEWAY_MASTER_SECRET:-}"
wanghai_image="${POLARIS_WANGHAI_VAULT_IMAGE:-}"
allowed_origins="${POLARIS_PORTAL_ALLOWED_ORIGINS:-}"
auth_mode="${POLARIS_AUTH_MODE:-}"

if [ "${auth_mode}" != "authing-browser-session" ]; then
  fail "POLARIS_AUTH_MODE must be authing-browser-session for a production release"
fi

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
    if (value.protocol !== "https:" || value.username || value.password || !value.hostname
      || value.search || value.hash) process.exit(1);
  ' "${auth_url}"; then
    fail "${auth_url_key} must be a valid HTTPS URL"
  fi
done

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
if (origin.protocol !== "https:" || origin.username || origin.password
  || origin.pathname !== "/" || origin.search || origin.hash || !origin.hostname) {
  process.exit(1);
}
process.stdout.write(origin.hostname.toLowerCase());
' "${gateway_origin}")" || fail "POLARIS_WANGHAI_GATEWAY_ORIGIN must be a bare HTTPS origin"

if [ -z "${allowed_origins}" ]; then
  fail "POLARIS_PORTAL_ALLOWED_ORIGINS is required"
fi
node -e '
const values = (process.argv[1] || "").split(",").map((value) => value.trim()).filter(Boolean);
if (values.length === 0 || values.some((value) => value === "*")) process.exit(1);
for (const value of values) {
  const origin = new URL(value);
  if (origin.protocol !== "https:" || origin.username || origin.password
    || origin.pathname !== "/" || origin.search || origin.hash) process.exit(1);
}
' "${allowed_origins}" || fail "POLARIS_PORTAL_ALLOWED_ORIGINS must contain explicit HTTPS origins"

if ! [[ "${wanghai_image}" =~ @sha256:[a-f0-9]{64}$ ]]; then
  fail "POLARIS_WANGHAI_VAULT_IMAGE must be a digest-pinned image reference"
fi

command -v docker >/dev/null 2>&1 || fail "docker is required for release preflight"
if ! docker image inspect "${wanghai_image}" >/dev/null 2>&1; then
  fail "digest-pinned Wanghai image is not present on the host"
fi

docker_ports="$(docker ps --format '{{.Names}}\t{{.Ports}}')" \
  || fail "unable to inspect Docker port mappings"
if printf '%s\n' "${docker_ports}" \
  | grep -Eq '(^|[,[:space:]])(0\.0\.0\.0|:::|\[::\]):[0-9]+->9090/tcp'; then
  fail "a public Docker mapping to Wanghai port 9090 is still active"
fi

probe_host="v-000000000000000000000000.${gateway_host}"
if ! getent ahosts "${probe_host}" >/dev/null 2>&1; then
  fail "gateway wildcard DNS does not resolve for the release probe host"
fi
if ! curl --proto '=https' --tlsv1.2 --silent --show-error --output /dev/null \
  --connect-timeout 10 --max-time 20 "https://${probe_host}/"; then
  fail "gateway wildcard TLS endpoint is not reachable or does not validate"
fi

printf 'release preflight: ok\n'
