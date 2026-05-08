#!/usr/bin/env bash
# run-gvisor-smoke-test.sh
# Validate that the gvisor RuntimeClass can start and complete a simple pod

set -euo pipefail

SCRIPT_NAME="$(basename "$0")"
POD_NAME="${GVISOR_SMOKE_POD_NAME:-gvisor-smoke-test}"
RUNTIME_CLASS="${GVISOR_SMOKE_RUNTIME_CLASS:-gvisor}"
IMAGE="${GVISOR_SMOKE_IMAGE:-busybox}"
EXPECTED_OUTPUT="${GVISOR_SMOKE_EXPECTED_OUTPUT:-gvisor works}"

log() {
  printf '[%s] %s\n' "$SCRIPT_NAME" "$*"
}

fail() {
  printf '[%s] ERROR: %s\n' "$SCRIPT_NAME" "$*" >&2
  exit 1
}

main() {
  [[ $EUID -eq 0 ]] || fail "Run this script with sudo or as root"

  log "Running smoke test with RuntimeClass ${RUNTIME_CLASS}..."
  k3s kubectl delete pod "$POD_NAME" --ignore-not-found=true

  k3s kubectl run "$POD_NAME" \
    --image="$IMAGE" \
    --restart=Never \
    --overrides="{\"spec\":{\"runtimeClassName\":\"${RUNTIME_CLASS}\"}}" \
    -- echo "$EXPECTED_OUTPUT"

  log "Waiting for smoke test pod..."
  k3s kubectl wait --for=condition=Ready "pod/${POD_NAME}" --timeout=60s 2>/dev/null || true
  k3s kubectl wait --for=jsonpath='{.status.phase}'=Succeeded "pod/${POD_NAME}" --timeout=60s

  local result
  result="$(k3s kubectl logs "$POD_NAME")"
  k3s kubectl delete pod "$POD_NAME" --ignore-not-found=true

  [[ "$result" == "$EXPECTED_OUTPUT" ]] \
    || fail "Smoke test failed. Got: \"$result\""
  log "Smoke test passed: \"$result\""
}

main "$@"
