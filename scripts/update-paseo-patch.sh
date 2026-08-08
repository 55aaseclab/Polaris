#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DIR="${ROOT_DIR}/apps/paseo/source"
PATCH_DIR="${ROOT_DIR}/apps/paseo/patches"
SOURCE_REF="${POLARIS_PASEO_SOURCE_REF:-v0.1.101}"

usage() {
  echo "Usage: $0 <patch-file> [pathspec...]" >&2
  exit 1
}

patch_name="${1:-}"
shift || true

if [ -z "${patch_name}" ]; then
  usage
fi

patch_file="${PATCH_DIR}/${patch_name}"
if [ ! -d "${SOURCE_DIR}/.git" ]; then
  echo "Missing paseo source git repo: ${SOURCE_DIR}" >&2
  exit 1
fi

if [ "$#" -gt 0 ]; then
  pathspecs=("$@")
else
  if [ ! -f "${patch_file}" ]; then
    echo "Missing patch file: ${patch_file}" >&2
    exit 1
  fi
  mapfile -t pathspecs < <(
    sed -n 's#^diff --git a/[^ ]\+ b/\(.*\)$#\1#p' "${patch_file}" | awk '!seen[$0]++'
  )
fi

if [ "${#pathspecs[@]}" -eq 0 ]; then
  echo "No pathspecs available for ${patch_file}" >&2
  exit 1
fi

tmp_file="$(mktemp "${PATCH_DIR}/.${patch_name}.XXXXXX")"
trap 'rm -f "${tmp_file}"' EXIT

git -C "${SOURCE_DIR}" diff --binary --no-ext-diff --full-index "${SOURCE_REF}" -- "${pathspecs[@]}" > "${tmp_file}"

if [ ! -s "${tmp_file}" ]; then
  echo "No diff produced for ${patch_name}" >&2
  exit 1
fi

mv "${tmp_file}" "${patch_file}"
trap - EXIT
echo "Updated ${patch_file}"
