#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./scripts/operations/print-workspace-image-tag.sh <user-profile-id> <project>

Example:
  ./scripts/operations/print-workspace-image-tag.sh 100000000000000002 morpheus
  # ttl.sh/user-002-morpheus:24h
EOF
}

sanitize_component() {
  local raw="${1:-}"
  local fallback="${2:-value}"
  local sanitized

  sanitized="$(printf '%s' "${raw}" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')"

  if [[ -z "${sanitized}" ]]; then
    sanitized="${fallback}"
  fi

  printf '%s\n' "${sanitized}"
}

user_segment() {
  local user_profile_id="${1:-}"

  if [[ "${user_profile_id}" =~ ^[0-9]+$ ]]; then
    local suffix="${user_profile_id: -3}"
    printf 'user-%03d\n' "${suffix}"
    return
  fi

  printf 'user-%s\n' "$(sanitize_component "${user_profile_id}" "default" | cut -c1-24)"
}

if [[ $# -ne 2 ]]; then
  usage
  exit 1
fi

printf 'ttl.sh/%s-%s:24h\n' \
  "$(user_segment "$1")" \
  "$(sanitize_component "$2" "workspace" | cut -c1-32)"
