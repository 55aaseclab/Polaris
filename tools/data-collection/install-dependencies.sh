#!/usr/bin/env bash
# Install local runtimes used by tools/data-collection (and phase-2 PDF capture).
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$ROOT_DIR/../.." && pwd)"
# shellcheck source=../load-env.sh
source "$ROOT_DIR/../load-env.sh"
polaris_literature_assert_local_command "setup"

echo "==> data-collection init (phase-2 email runtime, if backend is vendored)"
if [[ -d "$ROOT_DIR/backend/kichik-email-scraper" ]]; then
  "$ROOT_DIR/clue-data-collection" init
else
  echo "skip: backend/kichik-email-scraper not present (literature PDF path does not need it)"
fi

echo "==> tools/browser setup (Camofox / Playwright for phase-2 PDF capture)"
if [[ -x "$ROOT_DIR/../browser/clue-browser" ]]; then
  "$ROOT_DIR/../browser/clue-browser" setup
else
  echo "warn: tools/browser/clue-browser missing; PDF capture will fail until browser is installed" >&2
fi

echo "==> DISPLAY check (needed for headed Camofox / Xvfb)"
if [[ -n "${DISPLAY:-}" ]]; then
  echo "DISPLAY=$DISPLAY"
  if command -v xdpyinfo >/dev/null 2>&1; then
    xdpyinfo >/dev/null 2>&1 && echo "display: usable" || echo "display: set but not usable (check Xvfb / auth)" >&2
  fi
else
  echo "warn: DISPLAY is unset; set DISPLAY in repo .env (e.g. DISPLAY=:99) or start Xvfb" >&2
fi

echo "==> done"
echo "Details: $ROOT_DIR/../README.md"
echo "Env: set POLARIS_LITERATURE_ENV_FILE or export POLARIS_LITERATURE_* values"
