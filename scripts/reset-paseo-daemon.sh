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

log "Killing existing Paseo supervisors and workers..."
kubectl exec -n "$namespace" "$pod" -- sh -lc '
  self=$$
  parent=$PPID
  pids="$(
    pgrep -f "supervisor-entrypoint.js|daemon-worker.js|terminal-worker-process.js" \
      | grep -vx "$self" \
      | grep -vx "$parent" \
      || true
  )"
  if [ -n "$pids" ]; then
    kill -9 $pids || true
  fi
'

log "Waiting for old Paseo processes to disappear..."
for _ in $(seq 1 10); do
  remaining="$(
    kubectl exec -n "$namespace" "$pod" -- sh -lc '
      self=$$
      parent=$PPID
      pgrep -f "supervisor-entrypoint.js|daemon-worker.js|terminal-worker-process.js" \
        | grep -vx "$self" \
        | grep -vx "$parent" \
        || true
    ' 2>/dev/null || true
  )"
  if [[ -z "$remaining" ]]; then
    break
  fi
  sleep 1
done

remaining="$(
  kubectl exec -n "$namespace" "$pod" -- sh -lc '
    self=$$
    parent=$PPID
    pgrep -f "supervisor-entrypoint.js|daemon-worker.js|terminal-worker-process.js" \
      | grep -vx "$self" \
      | grep -vx "$parent" \
      || true
  ' 2>/dev/null || true
)"
[[ -z "$remaining" ]] || fail "Paseo processes are still running: $remaining"

log "Starting one fresh Paseo daemon..."
kubectl exec -n "$namespace" "$pod" -- sh -lc "
  rm -f ${DEFAULT_PASEO_HOME}/paseo.pid
  PASEO_HOME=${DEFAULT_PASEO_HOME} paseo daemon start
"

log "Waiting for fresh Paseo status..."
sleep 5
kubectl exec -n "$namespace" "$pod" -- sh -lc "
  PASEO_HOME=${DEFAULT_PASEO_HOME} paseo daemon status
"

log "Remaining Paseo process tree:"
kubectl exec -n "$namespace" "$pod" -- sh -lc '
  ps -ef | grep -E "supervisor-entrypoint.js|daemon-worker.js|terminal-worker-process.js" | grep -v grep || true
'

log "Paseo reset completed."
