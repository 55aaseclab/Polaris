#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

# shellcheck disable=SC1091
source "${ROOT_DIR}/scripts/lib/paseo-local.sh"

paseo_local_build_dist >/dev/null
paseo_local_verify_dist_base_url
printf 'artifact=%s\n' "$(paseo_local_dist_dir)"
