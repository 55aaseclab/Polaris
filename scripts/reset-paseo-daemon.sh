#!/usr/bin/env bash
# reset-paseo-daemon.sh
# Kill all Paseo processes in a running pod, remove the stale pid file,
# start one fresh daemon, and print the resulting status.

set -euo pipefail

SCRIPT_NAME="$(basename "$0")"
DEFAULT_NAMESPACE="morpheus"
DEFAULT_SELECTOR="app=morpheus"
DEFAULT_PASEO_HOME="/root/.paseo"

log() {
  printf '[%s] %s\n' "$SCRIPT_NAME" "$*"
}

fail() {
  printf '[%s] ERROR: %s\n' "$SCRIPT_NAME" "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage:
  reset-paseo-daemon.sh [namespace] [pod]

Defaults:
  namespace: morpheus
  pod: first pod matching label app=morpheus in the namespace
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

command -v kubectl >/dev/null 2>&1 || fail "kubectl is required"

namespace="${1:-$DEFAULT_NAMESPACE}"
pod="${2:-}"

if [[ -z "$pod" ]]; then
  pod="$(kubectl get pods -n "$namespace" -l "$DEFAULT_SELECTOR" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
fi

[[ -n "$pod" ]] || fail "Could not find a pod in namespace '$namespace' with selector '$DEFAULT_SELECTOR'"

log "Resetting Paseo in pod $pod (namespace $namespace)..."

kubectl exec -n "$namespace" "$pod" -- sh -lc "
  set -eux
  pkill -9 -f /opt/Paseo/Paseo || true
  sleep 2
  rm -f ${DEFAULT_PASEO_HOME}/paseo.pid
  PASEO_HOME=${DEFAULT_PASEO_HOME} paseo daemon start
  sleep 5
  PASEO_HOME=${DEFAULT_PASEO_HOME} paseo daemon status
"

log "Paseo reset completed."
