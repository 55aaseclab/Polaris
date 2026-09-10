#!/usr/bin/env bash
# Polaris literature-review environment adapter.
# Shared tool configuration and the integrated-mode guard live in tools/.
set -euo pipefail

WORKFLOW_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$WORKFLOW_ROOT/../.." && pwd)"
TOOLS_ROOT="$REPO_ROOT/tools"
source "$TOOLS_ROOT/load-env.sh"

# The workflow identity is owned here; common tools only own their own root.
export POLARIS_LITERATURE_WORKFLOW_ROOT="$WORKFLOW_ROOT"
