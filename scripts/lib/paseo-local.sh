#!/usr/bin/env bash

set -euo pipefail

POLARIS_PASEO_GIT_URL="${POLARIS_PASEO_GIT_URL:-https://github.com/cyruscyliu/paseo.git}"
POLARIS_PASEO_GIT_REF="${POLARIS_PASEO_GIT_REF:-3d6b4adc68dc426789974e7c0bbad9d783a34c1f}"
POLARIS_PASEO_WEB_BASE_URL="${POLARIS_PASEO_WEB_BASE_URL:-}"

paseo_local_npm() {
  npx -y npm@10.9.2 "$@"
}

paseo_local_runtime_root() {
  printf '.runtime/paseo-local\n'
}

paseo_local_checkout_dir() {
  printf '%s/checkout\n' "$(paseo_local_runtime_root)"
}

paseo_local_dist_dir() {
  printf '%s/dist\n' "$(paseo_local_runtime_root)"
}

paseo_local_ref_file() {
  printf '%s/ref\n' "$(paseo_local_runtime_root)"
}

paseo_local_patch_fingerprint_file() {
  printf '%s/patches.sha256\n' "$(paseo_local_runtime_root)"
}

paseo_local_patch_fingerprint() {
  {
    printf '%s\n' "base_url=${POLARIS_PASEO_WEB_BASE_URL}"
    find apps/paseo/patches -type f -print0 \
      | sort -z \
      | xargs -0 sha256sum
  } | sha256sum | awk '{print $1}'
}

paseo_local_prepare_dist() {
  local runtime_root checkout_dir dist_dir ref_file patch_file
  local current_ref current_patch wanted_patch base_url

  runtime_root="$(paseo_local_runtime_root)"
  checkout_dir="$(paseo_local_checkout_dir)"
  dist_dir="$(paseo_local_dist_dir)"
  ref_file="$(paseo_local_ref_file)"
  patch_file="$(paseo_local_patch_fingerprint_file)"
  wanted_patch="$(paseo_local_patch_fingerprint)"
  base_url="${POLARIS_PASEO_WEB_BASE_URL%/}"

  mkdir -p "${runtime_root}"

  current_ref="$(cat "${ref_file}" 2>/dev/null || true)"
  current_patch="$(cat "${patch_file}" 2>/dev/null || true)"

  if [ ! -d "${checkout_dir}/.git" ]; then
    rm -rf "${checkout_dir}"
    git clone "${POLARIS_PASEO_GIT_URL}" "${checkout_dir}" >&2
    current_ref=""
    current_patch=""
  fi

  if [ "${current_ref}" != "${POLARIS_PASEO_GIT_REF}" ] || [ "${current_patch}" != "${wanted_patch}" ]; then
    rm -rf "${checkout_dir}"
    git clone "${POLARIS_PASEO_GIT_URL}" "${checkout_dir}" >&2
    (
      cd "${checkout_dir}"
      git checkout "${POLARIS_PASEO_GIT_REF}" >&2
      git apply \
        "${OLDPWD}/apps/paseo/patches/paseo-web-base-url.patch" \
        "${OLDPWD}/apps/paseo/patches/paseo-web-registry-scope.patch" \
        "${OLDPWD}/apps/paseo/patches/paseo-web-defaults.patch" \
        "${OLDPWD}/apps/paseo/patches/paseo-web-offer-link.patch" >&2
      paseo_local_npm install >&2
      PASEO_WEB_BASE_URL="${POLARIS_PASEO_WEB_BASE_URL}" paseo_local_npm run build:web --workspace=@getpaseo/app >&2
    )
    rm -rf "${dist_dir}"
    mkdir -p "${dist_dir}"
    cp -a "${checkout_dir}/packages/app/dist/." "${dist_dir}/"
    if [ -n "${base_url}" ]; then
      sed -i "s#href=\"/manifest.json\"#href=\"${base_url}/manifest.json\"#" "${dist_dir}/index.html"
      sed -i "s#\"id\": \"/\"#\"id\": \"${base_url}/\"#" "${dist_dir}/manifest.json"
      sed -i "s#\"start_url\": \"/\"#\"start_url\": \"${base_url}/\"#" "${dist_dir}/manifest.json"
      sed -i "s#\"scope\": \"/\"#\"scope\": \"${base_url}/\"#" "${dist_dir}/manifest.json"
      sed -i "s#\"src\": \"/#\"src\": \"${base_url}/#g" "${dist_dir}/manifest.json"
    fi
    printf '%s\n' "${POLARIS_PASEO_GIT_REF}" > "${ref_file}"
    printf '%s\n' "${wanted_patch}" > "${patch_file}"
  fi

  printf '%s\n' "${dist_dir}"
}
