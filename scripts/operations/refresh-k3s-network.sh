#!/usr/bin/env bash
# refresh-k3s-network.sh
# Refresh k3s after a host network change and verify cluster DNS/metrics health.

set -euo pipefail

SCRIPT_NAME="$(basename "$0")"
K3S_TIMEOUT_SECONDS="${K3S_TIMEOUT_SECONDS:-180}"
API_TIMEOUT_SECONDS="${API_TIMEOUT_SECONDS:-120}"

log() {
  printf '[%s] %s\n' "$SCRIPT_NAME" "$*"
}

warn() {
  printf '[%s] WARN: %s\n' "$SCRIPT_NAME" "$*" >&2
}

fail() {
  printf '[%s] ERROR: %s\n' "$SCRIPT_NAME" "$*" >&2
  exit 1
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

require_root() {
  [[ $EUID -eq 0 ]] || fail "Run this script with sudo or as root"
}

show_resolver_state() {
  if command_exists resolvectl; then
    log "Current resolver state:"
    resolvectl status || warn "Could not read resolvectl status"
  elif [[ -f /etc/resolv.conf ]]; then
    log "Current /etc/resolv.conf:"
    cat /etc/resolv.conf
  else
    warn "No resolver status command found"
  fi
}

wait_for_node_ready() {
  local deadline status
  deadline=$((SECONDS + K3S_TIMEOUT_SECONDS))

  while (( SECONDS < deadline )); do
    status="$(k3s kubectl get nodes --no-headers 2>/dev/null | awk '{print $2}' || true)"
    if [[ "$status" == "Ready" ]]; then
      log "Node is Ready"
      return
    fi
    sleep 3
  done

  fail "Node did not become Ready after ${K3S_TIMEOUT_SECONDS}s"
}

wait_for_deployment() {
  local namespace="$1"
  local name="$2"

  log "Waiting for deployment/${name} in namespace ${namespace}..."
  k3s kubectl -n "$namespace" rollout status "deployment/${name}" --timeout="${K3S_TIMEOUT_SECONDS}s"
}

wait_for_apiservice() {
  local name="$1"
  local deadline condition
  deadline=$((SECONDS + API_TIMEOUT_SECONDS))

  while (( SECONDS < deadline )); do
    condition="$(k3s kubectl get apiservice "$name" -o jsonpath='{.status.conditions[?(@.type=="Available")].status}' 2>/dev/null || true)"
    if [[ "$condition" == "True" ]]; then
      log "APIService ${name} is Available"
      return
    fi
    sleep 3
  done

  fail "APIService ${name} did not become Available after ${API_TIMEOUT_SECONDS}s"
}

show_cluster_summary() {
  log "kube-system pod status:"
  k3s kubectl -n kube-system get pods

  log "CoreDNS service:"
  k3s kubectl -n kube-system get svc kube-dns

  log "Metrics APIService:"
  k3s kubectl get apiservice v1beta1.metrics.k8s.io

  if ! k3s kubectl top nodes; then
    warn "kubectl top nodes failed; metrics may still be warming up"
  fi
}

main() {
  require_root
  command_exists k3s || fail "k3s is not installed"

  show_resolver_state

  log "Restarting k3s..."
  systemctl restart k3s

  wait_for_node_ready
  wait_for_deployment kube-system coredns
  wait_for_deployment kube-system metrics-server
  wait_for_apiservice v1beta1.metrics.k8s.io
  show_cluster_summary

  log "Network refresh complete"
}

main "$@"
