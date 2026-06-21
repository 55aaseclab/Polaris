#!/usr/bin/env bash
# setup-k3s-kubevirt.sh
# Install or update KubeVirt on the current k3s cluster.

set -euo pipefail

SCRIPT_NAME="$(basename "$0")"
KUBEVIRT_NAMESPACE="kubevirt"
KUBEVIRT_RELEASE="${KUBEVIRT_RELEASE:-}"
KUBEVIRT_STABLE_URL="https://storage.googleapis.com/kubevirt-prow/release/kubevirt/kubevirt/stable.txt"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KUBEVIRT_CR_PATH="${REPO_ROOT}/config/kubevirt/kubevirt-cr.yaml"

log() {
  printf '[%s] %s\n' "$SCRIPT_NAME" "$*"
}

fail() {
  printf '[%s] ERROR: %s\n' "$SCRIPT_NAME" "$*" >&2
  exit 1
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

preflight() {
  command_exists kubectl || fail "kubectl is required"
  command_exists curl || fail "curl is required"
  [[ -f "$KUBEVIRT_CR_PATH" ]] || fail "missing ${KUBEVIRT_CR_PATH}"
}

resolve_release() {
  if [[ -n "$KUBEVIRT_RELEASE" ]]; then
    printf '%s\n' "$KUBEVIRT_RELEASE"
    return
  fi
  curl -fsSL "$KUBEVIRT_STABLE_URL"
}

apply_release() {
  local release="$1"
  log "Installing KubeVirt ${release}..."
  kubectl apply -f "https://github.com/kubevirt/kubevirt/releases/download/${release}/kubevirt-operator.yaml"
  kubectl apply -f "$KUBEVIRT_CR_PATH"
}

wait_ready() {
  log "Waiting for KubeVirt to become Available..."
  kubectl -n "$KUBEVIRT_NAMESPACE" wait kv kubevirt --for=condition=Available --timeout=600s
}

print_summary() {
  log "KubeVirt is ready."
  kubectl get kubevirt -n "$KUBEVIRT_NAMESPACE"
  kubectl get pods -n "$KUBEVIRT_NAMESPACE"
}

main() {
  preflight
  local release
  release="$(resolve_release)"
  log "Resolved KubeVirt release: ${release}"
  apply_release "$release"
  wait_ready
  print_summary
}

main "$@"
