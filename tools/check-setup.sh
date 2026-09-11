#!/usr/bin/env bash
# Shared Polaristool tool check. Each tool's ./check-setup sources this.
set -euo pipefail
TOOL_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[1]}")" && pwd)"
TOOLS_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$TOOLS_ROOT/load-env.sh" ]]; then
  # shellcheck source=./load-env.sh
  source "$TOOLS_ROOT/load-env.sh"
fi
exec python3 "$TOOLS_ROOT/check-setup.py" --root "$TOOL_ROOT" "$@"
