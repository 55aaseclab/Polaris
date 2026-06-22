#!/usr/bin/env bash
# print-k3s-worker-join-info.sh
# Print the environment variables needed to join a worker to this k3s cluster

set -euo pipefail

SCRIPT_NAME="$(basename "$0")"
NODE_TOKEN_PATH="/var/lib/rancher/k3s/server/node-token"

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
  [[ $EUID -eq 0 ]] || fail "Run this script with sudo or as root"
  command_exists k3s || fail "k3s is not installed on this node"
  [[ -f "$NODE_TOKEN_PATH" ]] || fail "Node token not found at $NODE_TOKEN_PATH"
}

default_ip() {
  hostname -I 2>/dev/null | awk '{print $1}'
}

main() {
  preflight

  local token ip
  token="$(<"$NODE_TOKEN_PATH")"
  ip="$(default_ip)"

  [[ -n "$ip" ]] || fail "Could not determine a control-plane IP address from hostname -I"

  log "Use this control-plane address for K3S_URL:"
  printf '  export K3S_URL=https://%s:6443\n' "$ip"
  printf '  export K3S_TOKEN=%q\n' "$token"
  printf '\n'
  log "Example worker command:"
  printf '  sudo K3S_URL=https://%s:6443 \\\n' "$ip"
  printf '       K3S_TOKEN=%q \\\n' "$token"
  printf '       ./scripts/operations/setup-k3s-sandbox-worker.sh\n'
}

main "$@"
