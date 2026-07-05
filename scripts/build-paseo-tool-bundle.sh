#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

# shellcheck disable=SC1091
source "${ROOT_DIR}/scripts/lib/paseo-local.sh"

paseo_local_build_tool_bundle >/dev/null
printf 'bundle=%s\n' "$(paseo_local_tool_bundle_dir)"
