#!/usr/bin/env bash

set -euo pipefail

POLARIS_PASEO_WEB_BASE_URL="${POLARIS_PASEO_WEB_BASE_URL:-/paseo}"
POLARIS_PASEO_BUILDER_NAME="${POLARIS_PASEO_BUILDER_NAME:-polaris-builder}"

paseo_local_runtime_root() {
  printf '.runtime/paseo-local\n'
}

paseo_local_dist_dir() {
  printf 'apps/paseo/dist-build\n'
}

paseo_local_fingerprint_file() {
  printf '%s/inputs.sha256\n' "$(paseo_local_runtime_root)"
}

paseo_local_buildkit_cache_dir() {
  printf '%s/buildkit-cache\n' "$(paseo_local_runtime_root)"
}

paseo_local_input_fingerprint() {
  {
    printf '%s\n' "base_url=${POLARIS_PASEO_WEB_BASE_URL}"
    sha256sum apps/paseo/rewrite-export-base-url.mjs
    find apps/paseo/source apps/paseo/patches -type f -print0 \
      | sort -z \
      | xargs -0 sha256sum
    sha256sum apps/paseo/Dockerfile.artifact
  } | sha256sum | awk '{print $1}'
}

paseo_local_build_dist() {
  local runtime_root dist_dir fingerprint_file cache_dir wanted_fingerprint tmp_dir

  runtime_root="$(paseo_local_runtime_root)"
  dist_dir="$(paseo_local_dist_dir)"
  fingerprint_file="$(paseo_local_fingerprint_file)"
  cache_dir="$(paseo_local_buildkit_cache_dir)"
  wanted_fingerprint="$(paseo_local_input_fingerprint)"

  mkdir -p "${runtime_root}" "${cache_dir}"

  if [ -d "${dist_dir}" ] && [ "$(cat "${fingerprint_file}" 2>/dev/null || true)" = "${wanted_fingerprint}" ]; then
    printf '%s\n' "${dist_dir}"
    return
  fi

  tmp_dir="$(mktemp -d "${runtime_root}/dist.XXXXXX")"
  trap 'rm -rf "${tmp_dir}"' RETURN

  docker buildx build \
    --builder "${POLARIS_PASEO_BUILDER_NAME}" \
    --file apps/paseo/Dockerfile.artifact \
    --target artifact-export \
    --build-arg "PASEO_WEB_BASE_URL=${POLARIS_PASEO_WEB_BASE_URL}" \
    --cache-from "type=local,src=${cache_dir}" \
    --cache-to "type=local,dest=${cache_dir},mode=max" \
    --output "type=local,dest=${tmp_dir}" \
    .

  rm -rf "${dist_dir}"
  mkdir -p "${dist_dir}"
  cp -a "${tmp_dir}/dist/." "${dist_dir}/"
  printf '%s\n' "${wanted_fingerprint}" > "${fingerprint_file}"
  paseo_local_verify_dist_base_url
  printf '%s\n' "${dist_dir}"
}

paseo_local_verify_dist_base_url() {
  local dist_dir base_url index_file manifest_file

  dist_dir="$(paseo_local_dist_dir)"
  base_url="${POLARIS_PASEO_WEB_BASE_URL%/}"
  index_file="${dist_dir}/index.html"
  manifest_file="${dist_dir}/manifest.json"

  if [ ! -f "${index_file}" ] || [ ! -f "${manifest_file}" ]; then
    printf 'paseo artifact verification failed: missing index.html or manifest.json\n' >&2
    return 1
  fi

  if [ -n "${base_url}" ]; then
    grep -q "href=\"${base_url}/manifest.json\"" "${index_file}"
    grep -q "href=\"${base_url}/_expo/static/css/" "${index_file}"
    grep -q "src=\"${base_url}/_expo/static/js/web/" "${index_file}"
    grep -q "\"start_url\": \"${base_url}/\"" "${manifest_file}"
    grep -q "\"scope\": \"${base_url}/\"" "${manifest_file}"
    if grep -Eq '(href|src)="/(_expo|manifest\.json|favicon\.ico|apple-touch-icon\.png)' "${index_file}"; then
      printf 'paseo artifact verification failed: root-absolute asset path remained in index.html\n' >&2
      return 1
    fi
  fi
}

paseo_local_clean() {
  rm -rf "$(paseo_local_runtime_root)" "$(paseo_local_dist_dir)"
}
