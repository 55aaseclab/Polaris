#!/usr/bin/env bash
set -euo pipefail

polaris_deploy_fingerprint_paths() {
  local root_dir="$1"
  shift
  (
    cd "${root_dir}"
    local rel
    for rel in "$@"; do
      if [ -d "${rel}" ]; then
        while IFS= read -r path; do
          sha256sum "${path}"
        done < <(find "${rel}" -type f | LC_ALL=C sort)
      elif [ -f "${rel}" ]; then
        sha256sum "${rel}"
      else
        printf 'missing  %s\n' "${rel}"
      fi
    done
  ) | sha256sum | awk '{print $1}'
}

polaris_deploy_executor_fingerprint() {
  local root_dir="$1"
  local env_file="$2"
  polaris_deploy_fingerprint_paths \
    "${root_dir}" \
    "apps/polaris/dist" \
    "apps/polaris/package.json" \
    "package.json" \
    "pnpm-lock.yaml" \
    "pnpm-workspace.yaml" \
    "scripts/run-polaris-executor-host.sh" \
    "${env_file}"
}

polaris_deploy_bridge_fingerprint() {
  local root_dir="$1"
  polaris_deploy_fingerprint_paths \
    "${root_dir}" \
    "scripts/run-polaris-executor-bridge-proxy.sh"
}

polaris_deploy_fingerprint_state_path() {
  local root_dir="$1"
  local service_name="$2"
  printf '%s\n' "${root_dir}/.runtime/deploy/${service_name}.sha256"
}

polaris_deploy_service_changed() {
  local root_dir="$1"
  local service_name="$2"
  local next_fingerprint="$3"
  local state_path
  state_path="$(polaris_deploy_fingerprint_state_path "${root_dir}" "${service_name}")"
  if [ ! -f "${state_path}" ]; then
    return 0
  fi
  local current_fingerprint
  current_fingerprint="$(cat "${state_path}")"
  [ "${current_fingerprint}" != "${next_fingerprint}" ]
}

polaris_deploy_record_fingerprint() {
  local root_dir="$1"
  local service_name="$2"
  local fingerprint="$3"
  local state_path
  state_path="$(polaris_deploy_fingerprint_state_path "${root_dir}" "${service_name}")"
  mkdir -p "$(dirname "${state_path}")"
  printf '%s\n' "${fingerprint}" > "${state_path}"
}
