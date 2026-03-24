#!/usr/bin/env bash

set -euo pipefail

SCRIPT_NAME="$(basename "$0")"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="back-agentctl-$(date +%s)"
WORK_DIR="$(mktemp -d)"
CONFIG_PATH="$REPO_ROOT/agents/$PROJECT.agent.yaml"
MANIFEST_PATH="$REPO_ROOT/agents/$PROJECT.yaml"

log() {
  printf '[%s] %s\n' "$SCRIPT_NAME" "$*"
}

fail() {
  printf '[%s] ERROR: %s\n' "$SCRIPT_NAME" "$*" >&2
  exit 1
}

cleanup() {
  rm -f "$CONFIG_PATH" "$MANIFEST_PATH"
  rm -rf "$WORK_DIR"
}

trap cleanup EXIT

mkdir -p "$WORK_DIR"

log "Running agentctl wizard with backtracking from memory to CPU"

cat <<EOF | TERM=dumb python3 "$REPO_ROOT/scripts/agentctl.py" >/tmp/test-agentctl-back.log 2>&1
$PROJECT
$WORK_DIR




5
3
back
5
4


3

n
n
EOF

test -f "$CONFIG_PATH" || fail "Expected config file was not created"
test -f "$MANIFEST_PATH" || fail "Expected manifest file was not created"

log "Validating saved config values"
python3 - <<PY
import pathlib
import yaml

config = pathlib.Path("${CONFIG_PATH}")
data = yaml.safe_load(config.read_text())

assert data["project"] == "${PROJECT}", data
assert data["resources"]["cpu"] == "4", data["resources"]
assert data["resources"]["memory"] == "4Gi", data["resources"]
assert data["resources"]["ephemeral_storage"] == "20Gi", data["resources"]
assert data["agent"]["kind"] == "none", data["agent"]
print("agentctl backtracking config verified")
PY

log "agentctl backtracking shell test passed"
