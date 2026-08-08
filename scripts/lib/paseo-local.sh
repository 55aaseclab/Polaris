#!/usr/bin/env bash

set -euo pipefail

POLARIS_PASEO_WEB_BASE_URL="${POLARIS_PASEO_WEB_BASE_URL:-}"
POLARIS_PASEO_BUILDER_NAME="${POLARIS_PASEO_BUILDER_NAME:-polaris-builder}"
POLARIS_PASEO_SOURCE_REF="${POLARIS_PASEO_SOURCE_REF:-v0.1.101}"
POLARIS_PASEO_BUILD_TIMEOUT_SECONDS="${POLARIS_PASEO_BUILD_TIMEOUT_SECONDS:-600}"
BUILDKIT_PROGRESS="${BUILDKIT_PROGRESS:-plain}"
export BUILDKIT_PROGRESS

paseo_local_ensure_source() {
  local source_dir="apps/paseo/source"

  if [ -f "${source_dir}/package.json" ] \
    && [ -d "${source_dir}/.git" ] \
    && git -C "${source_dir}" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    && git -C "${source_dir}" rev-parse --verify 'HEAD^{commit}' >/dev/null 2>&1; then
    return
  fi

  if [ -d "${source_dir}" ] && [ -n "$(find "${source_dir}" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
    printf 'Paseo source is incomplete or lacks usable Git metadata: %s\n' "${source_dir}" >&2
    return 1
  fi

  rm -rf "${source_dir}"
  git clone --depth 1 --branch "${POLARIS_PASEO_SOURCE_REF}" \
    https://github.com/getpaseo/paseo.git "${source_dir}"
}

paseo_local_runtime_root() {
  printf '.runtime/paseo-local\n'
}

paseo_local_dist_dir() {
  printf 'apps/paseo/dist-build\n'
}

paseo_local_prepare_served_layout() { :; }

paseo_local_fingerprint_file() {
  printf '%s/inputs.sha256\n' "$(paseo_local_runtime_root)"
}

paseo_local_buildkit_cache_dir() {
  printf '%s/buildkit-cache\n' "$(paseo_local_runtime_root)"
}

paseo_local_ensure_builder() {
  if docker buildx inspect "${POLARIS_PASEO_BUILDER_NAME}" >/dev/null 2>&1; then
    return
  fi

  docker buildx create \
    --name "${POLARIS_PASEO_BUILDER_NAME}" \
    --driver docker-container \
    --bootstrap >/dev/null
}

paseo_local_recreate_builder() {
  docker buildx rm --force "${POLARIS_PASEO_BUILDER_NAME}" >/dev/null 2>&1 || true
  docker buildx create \
    --name "${POLARIS_PASEO_BUILDER_NAME}" \
    --driver docker-container \
    --bootstrap >/dev/null
}

paseo_local_buildx_export() {
  local cache_dir="$1"
  shift
  local -a build_args=(
    --progress plain
    --builder "${POLARIS_PASEO_BUILDER_NAME}"
    "$@"
  )

  if [ -d "${cache_dir}" ]; then
    build_args=(--cache-from "type=local,src=${cache_dir}" "${build_args[@]}")
  fi

  if timeout --foreground --kill-after=30s "${POLARIS_PASEO_BUILD_TIMEOUT_SECONDS}s" \
    docker buildx build "${build_args[@]}"; then
    return 0
  fi

  printf 'Paseo BuildKit export failed or timed out; recreating builder and retrying once.\n' >&2
  paseo_local_recreate_builder
  timeout --foreground --kill-after=30s "${POLARIS_PASEO_BUILD_TIMEOUT_SECONDS}s" \
    docker buildx build "${build_args[@]}"
}

paseo_local_buildx_with_local_cache() {
  local cache_dir cache_tmp
  cache_dir="$1"
  shift
  cache_tmp="${cache_dir}.tmp"

  rm -rf "${cache_tmp}"
  mkdir -p "$(dirname "${cache_dir}")"
  paseo_local_ensure_builder

  if [ -d "${cache_dir}" ]; then
    docker buildx build \
      --progress plain \
      --cache-from "type=local,src=${cache_dir}" \
      --cache-to "type=local,dest=${cache_tmp},mode=max" \
      "$@"
  else
    docker buildx build \
      --progress plain \
      --cache-to "type=local,dest=${cache_tmp},mode=max" \
      "$@"
  fi

  rm -rf "${cache_dir}"
  mv "${cache_tmp}" "${cache_dir}"
}

paseo_local_tool_bundle_dir() {
  printf 'apps/paseo/tool-bundle\n'
}

paseo_local_tool_bundle_fingerprint_file() {
  printf '%s/tool-bundle.sha256\n' "$(paseo_local_runtime_root)"
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

paseo_local_tool_bundle_fingerprint() {
  {
    find apps/paseo/source apps/paseo/patches -type f -print0 \
      | sort -z \
      | xargs -0 sha256sum
    sha256sum apps/paseo/Dockerfile.tool-bundle
  } | sha256sum | awk '{print $1}'
}

paseo_local_build_dist() {
  local runtime_root dist_dir fingerprint_file cache_dir wanted_fingerprint tmp_dir

  paseo_local_ensure_source
  runtime_root="$(paseo_local_runtime_root)"
  dist_dir="$(paseo_local_dist_dir)"
  fingerprint_file="$(paseo_local_fingerprint_file)"
  cache_dir="$(paseo_local_buildkit_cache_dir)"
  wanted_fingerprint="$(paseo_local_input_fingerprint)"

  mkdir -p "${runtime_root}" "${cache_dir}"

  paseo_local_prepare_served_layout >/dev/null 2>&1 || true

  if [ -d "${dist_dir}" ] && [ "$(cat "${fingerprint_file}" 2>/dev/null || true)" = "${wanted_fingerprint}" ]; then
    paseo_local_prepare_served_layout
    printf '%s\n' "${dist_dir}"
    return
  fi

  tmp_dir="$(mktemp -d "${runtime_root}/dist.XXXXXX")"
  trap 'rm -rf "${tmp_dir}"' RETURN

  # The local cache exporter can hang indefinitely here while exporting BuildKit
  # cache state. Reuse any existing cache for reads, but skip cache writes so
  # deploy and local artifact builds complete reliably.
  paseo_local_ensure_builder
  paseo_local_buildx_export "${cache_dir}" \
    --file apps/paseo/Dockerfile.artifact \
    --target artifact-export \
    --build-arg "PASEO_SOURCE_REF=${POLARIS_PASEO_SOURCE_REF}" \
    --build-arg "PASEO_WEB_BASE_URL=${POLARIS_PASEO_WEB_BASE_URL}" \
    --output "type=local,dest=${tmp_dir}" \
    .

  rm -rf "${dist_dir}"
  mkdir -p "${dist_dir}"
  cp -a "${tmp_dir}/dist/." "${dist_dir}/"
  paseo_local_prepare_served_layout
  printf '%s\n' "${wanted_fingerprint}" > "${fingerprint_file}"
  paseo_local_verify_dist_base_url
  printf '%s\n' "${dist_dir}"
}

paseo_local_build_tool_bundle() {
  local runtime_root bundle_dir fingerprint_file cache_dir wanted_fingerprint tmp_dir

  paseo_local_ensure_source
  runtime_root="$(paseo_local_runtime_root)"
  bundle_dir="$(paseo_local_tool_bundle_dir)"
  fingerprint_file="$(paseo_local_tool_bundle_fingerprint_file)"
  cache_dir="$(paseo_local_buildkit_cache_dir)"
  wanted_fingerprint="$(paseo_local_tool_bundle_fingerprint)"

  mkdir -p "${runtime_root}" "${cache_dir}" "${bundle_dir}"

  if [ -x "${bundle_dir}/bin/paseo" ] && [ "$(cat "${fingerprint_file}" 2>/dev/null || true)" = "${wanted_fingerprint}" ]; then
    printf '%s\n' "${bundle_dir}"
    return
  fi

  tmp_dir="$(mktemp -d "${runtime_root}/bundle.XXXXXX")"
  trap 'rm -rf "${tmp_dir}"' RETURN
  # The local cache exporter can hang indefinitely for the tool bundle build
  # while exporting the client directory. Reuse the existing cache for reads,
  # but skip cache writes here so deploys stay reliable.
  paseo_local_ensure_builder
  paseo_local_buildx_export "${cache_dir}" \
    --file apps/paseo/Dockerfile.tool-bundle \
    --target bundle-export \
    --build-arg "PASEO_SOURCE_REF=${POLARIS_PASEO_SOURCE_REF}" \
    --output "type=local,dest=${tmp_dir}" \
    .

  rm -rf "${bundle_dir}"
  mkdir -p "${bundle_dir}"
  cp -a "${tmp_dir}/bundle/." "${bundle_dir}/"
  printf '%s\n' "${wanted_fingerprint}" > "${fingerprint_file}"
  printf '%s\n' "${bundle_dir}"
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
