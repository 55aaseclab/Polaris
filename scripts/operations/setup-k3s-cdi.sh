#!/usr/bin/env bash
# setup-k3s-cdi.sh
# Install or update the KubeVirt CDI (Containerized Data Importer) control plane.

set -euo pipefail

SCRIPT_NAME="$(basename "$0")"
CDI_NAMESPACE="cdi"
CDI_RELEASE="${CDI_RELEASE:-v1.65.0}"

log() {
  printf '[%s] %s\n' "$SCRIPT_NAME" "$*"
}

fail() {
  printf '[%s] ERROR: %s\n' "$SCRIPT_NAME" "$*" >&2
  exit 1
}

command -v kubectl >/dev/null 2>&1 || fail "kubectl is required"

log "Installing CDI ${CDI_RELEASE}..."
kubectl apply -f "https://github.com/kubevirt/containerized-data-importer/releases/download/${CDI_RELEASE}/cdi-operator.yaml"
kubectl apply -f "https://github.com/kubevirt/containerized-data-importer/releases/download/${CDI_RELEASE}/cdi-cr.yaml"

log "Waiting for CDI to become Available..."
kubectl -n "$CDI_NAMESPACE" wait cdi cdi --for=condition=Available --timeout=600s

log "CDI is ready."
kubectl get cdi -n "$CDI_NAMESPACE"
kubectl get pods -n "$CDI_NAMESPACE"
