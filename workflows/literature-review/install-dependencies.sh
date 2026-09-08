#!/usr/bin/env bash
# Install dependencies owned by the Polaris common tools and literature workflow.
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TOOLS_DIR="$(cd -- "$ROOT_DIR/../../tools" && pwd)"
source "$ROOT_DIR/load-env.sh"
polaris_literature_assert_local_command "setup"

SKIP_BROWSER=0
SKIP_EXTERNAL_BACKENDS=0
WITH_CONTAINER_BACKENDS=0

usage() {
  cat <<'EOF'
Usage: install-dependencies.sh [options]

Install the runtimes and locked external backends used by the Polaris
literature-review workflow and its common tools. The script never writes a
credential or env file.

Options:
  --skip-browser             Do not install browser package/runtime deps.
  --skip-external-backends   Do not clone locked SearXNG/JustOneAPI sources.
  --with-container-backends  Pull the locked local SearXNG image.
  -h, --help                 Show this help.

The workflow's required environment is POLARIS_LITERATURE_*; use
POLARIS_LITERATURE_ENV_FILE for a private env file.
EOF
}

die() {
  echo "error: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

locked_backend_value() {
  local lock_file="$1"
  local query="$2"
  jq -er "$query" "$lock_file"
}

checkout_locked_backend() {
  local lock_file="$1"
  local tool_dir="$2"
  local repository reference commit relative_path backend_dir actual_commit

  repository="$(locked_backend_value "$lock_file" '.backend.repository')"
  reference="$(locked_backend_value "$lock_file" '.backend.ref')"
  commit="$(locked_backend_value "$lock_file" '.backend.commit')"
  relative_path="$(locked_backend_value "$lock_file" '.backend.path')"
  [[ "$relative_path" != /* && "$relative_path" != *..* ]] || die \
    "invalid locked backend path in $lock_file"
  backend_dir="$tool_dir/$relative_path"

  if [[ -e "$backend_dir" || -L "$backend_dir" ]]; then
    [[ ! -L "$backend_dir" && -d "$backend_dir/.git" ]] || die \
      "locked backend is not a Git checkout: $backend_dir"
    [[ -z "$(git -C "$backend_dir" status --porcelain)" ]] || die \
      "locked backend has local changes and will not be modified: $backend_dir"
    actual_commit="$(git -C "$backend_dir" rev-parse HEAD 2>/dev/null || true)"
    if [[ "$actual_commit" == "$commit" ]]; then
      echo "locked backend already ready: $backend_dir"
      return
    fi
    if ! git -C "$backend_dir" fetch --depth 1 origin "$commit"; then
      git -C "$backend_dir" fetch --filter=blob:none origin
    fi
  else
    mkdir -p "$(dirname "$backend_dir")"
    git init --quiet "$backend_dir"
    git -C "$backend_dir" remote add origin "$repository"
    if ! git -C "$backend_dir" fetch --depth 1 origin "$commit"; then
      git -C "$backend_dir" fetch --filter=blob:none origin
    fi
  fi
  git -C "$backend_dir" switch --detach "$commit" >/dev/null
  actual_commit="$(git -C "$backend_dir" rev-parse HEAD)"
  [[ "$actual_commit" == "$commit" ]] || die \
    "locked commit $commit was not checked out in $backend_dir"
  echo "locked backend ready: $reference ($commit)"
}

install_social_media_runtime() {
  local backend_dir="$TOOLS_DIR/social-media/backend/justoneapi-python"
  local venv_dir="$TOOLS_DIR/social-media/.venv"
  local python="$venv_dir/bin/python"
  [[ -f "$backend_dir/requirements.txt" ]] || die \
    "locked JustOneAPI SDK has no requirements.txt"
  if [[ ! -x "$python" ]]; then
    require_command python3
    python3 -m venv "$venv_dir"
  fi
  "$python" -m pip install --disable-pip-version-check \
    --requirement "$backend_dir/requirements.txt"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-browser) SKIP_BROWSER=1 ;;
    --skip-external-backends) SKIP_EXTERNAL_BACKENDS=1 ;;
    --with-container-backends) WITH_CONTAINER_BACKENDS=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

require_command jq
require_command git

if [[ "$SKIP_EXTERNAL_BACKENDS" == 0 ]]; then
  checkout_locked_backend \
    "$TOOLS_DIR/web-search/backend.lock.json" "$TOOLS_DIR/web-search"
  checkout_locked_backend \
    "$TOOLS_DIR/social-media/backend.lock.json" "$TOOLS_DIR/social-media"
  install_social_media_runtime
fi

if [[ "$SKIP_BROWSER" == 0 ]]; then
  "$TOOLS_DIR/browser/clue-browser" setup
fi

if [[ "$WITH_CONTAINER_BACKENDS" == 1 ]]; then
  require_command docker
  [[ "$SKIP_EXTERNAL_BACKENDS" == 0 ]] || die \
    "--with-container-backends requires locked external backends"
  "$TOOLS_DIR/web-search/clue-web-search-cli" build-backend
fi

echo "Polaris literature-review dependencies are ready."
