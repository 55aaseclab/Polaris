#!/usr/bin/env bash
# Shared environment boundary for Polaris business tools.
#
# A caller may select a private env file with POLARIS_BUSINESS_ENV_FILE.
# Explicitly exported values always win. Wanghai settings are never forwarded.
set -euo pipefail

BUSINESS_TOOLS_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
BUSINESS_ENV_FILE="${POLARIS_BUSINESS_ENV_FILE:-}"

declare -A _POLARIS_BUSINESS_SAVED _POLARIS_BUSINESS_PRESENT
for _key in \
  POLARIS_BUSINESS_DATA_ROOT POLARIS_BUSINESS_WORKSPACES_ROOT \
  POLARIS_BUSINESS_BACKUP_ROOT POLARIS_BUSINESS_CACHE_ROOT \
  POLARIS_BUSINESS_RUNTIME_MODE POLARIS_BUSINESS_VIDEO_FONT \
  POLARIS_BUSINESS_ENV_FILE JIEKOU_API_KEY JIEKOU_TOKEN JIEKOU_BASE_URL \
  JIEKOU_API_BASE FFMPEG_PATH FFPROBE_PATH DISPLAY; do
  if [[ ${!_key+x} == x ]]; then
    _POLARIS_BUSINESS_PRESENT["$_key"]=1
    _POLARIS_BUSINESS_SAVED["$_key"]="${!_key}"
  fi
done

if [[ -n "$BUSINESS_ENV_FILE" ]]; then
  [[ -f "$BUSINESS_ENV_FILE" ]] || {
    echo "error: POLARIS_BUSINESS_ENV_FILE does not exist: $BUSINESS_ENV_FILE" >&2
    exit 2
  }
  set -a
  # shellcheck disable=SC1090
  source "$BUSINESS_ENV_FILE"
  set +a
fi

for _key in "${!_POLARIS_BUSINESS_PRESENT[@]}"; do
  export "$_key=${_POLARIS_BUSINESS_SAVED[$_key]}"
done

# A migrated tool never consumes the old application's configuration namespace.
for _key in "${!WANGHAI_@}"; do
  [[ -n "$_key" ]] && unset "$_key"
done

polaris_business_assert_command() {
  local command="${1:-}"
  if [[ "${POLARIS_BUSINESS_RUNTIME_MODE:-local}" != "polaris" ]]; then
    return 0
  fi
  case "$command" in
    version|backend-status|help|--help|-h|validate|validate-input|validate-output|platforms|templates)
      return 0
      ;;
    *)
      echo "error: integrated business-tool execution requires a Polaris durable action service" >&2
      return 2
      ;;
  esac
}

if [[ "${POLARIS_BUSINESS_RUNTIME_MODE:-local}" == "polaris" ]]; then
  # These are standalone transport/configuration values. Polaris must inject
  # reviewed credentials through its own durable action boundary.
  for _key in "${!SMTP_@}" "${!OUTREACH_@}" JIEKOU_API_KEY JIEKOU_TOKEN JIEKOU_BASE_URL JIEKOU_API_BASE; do
    [[ -n "$_key" ]] && unset "$_key"
  done
fi
