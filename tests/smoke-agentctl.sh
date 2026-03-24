#!/usr/bin/env bash

set -euo pipefail

SCRIPT_NAME="$(basename "$0")"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="smoke-agentctl-$(date +%s)"
WORK_DIR="$(mktemp -d)"

log() {
  printf '[%s] %s\n' "$SCRIPT_NAME" "$*"
}

cleanup() {
  kubectl delete namespace "$PROJECT" --ignore-not-found=true --wait=false >/dev/null 2>&1 || true
  rm -f "$REPO_ROOT/agents/$PROJECT.agent.yaml" "$REPO_ROOT/agents/$PROJECT.yaml"
  rm -rf "$WORK_DIR"
}

trap cleanup EXIT

if ! command -v kubectl >/dev/null 2>&1; then
  log "Skipping: kubectl is not available"
  exit 0
fi

if ! kubectl get runtimeclass kata-qemu >/dev/null 2>&1; then
  log "Skipping: kata-qemu runtimeclass is not available"
  exit 0
fi

log "Generating canonical config and rendered manifest for $PROJECT"
python3 - <<PY
from pathlib import Path
from scripts.agentctl import AgentConfig, write_project_files

cfg = AgentConfig(
    project_name="${PROJECT}",
    host_path="${WORK_DIR}",
    mount_path="/workspace",
    runtime_class="kata-qemu",
    base_image="debian:trixie-slim",
    cpu="1",
    memory="2Gi",
    storage="10Gi",
    agent="None",
    agent_cmd="",
    permissive_mode="",
    agent_args="",
    persist_state=False,
    all_packages="",
    bootstrap_profile="minimal",
)
Path("${WORK_DIR}").mkdir(parents=True, exist_ok=True)
write_project_files(cfg)
PY

test -f "$REPO_ROOT/agents/$PROJECT.agent.yaml"
test -f "$REPO_ROOT/agents/$PROJECT.yaml"

log "Applying rendered manifest"
kubectl apply -f "$REPO_ROOT/agents/$PROJECT.yaml"

log "Waiting for pod creation"
for _ in $(seq 1 90); do
  if kubectl -n "$PROJECT" get pod -l "app=$PROJECT" -o name | grep -q .; then
    break
  fi
  sleep 2
done

log "Waiting for pod scheduling"
kubectl -n "$PROJECT" wait --for=jsonpath='{.status.phase}'=Running pod -l "app=$PROJECT" --timeout=180s || {
  kubectl -n "$PROJECT" get pods -o wide || true
  kubectl -n "$PROJECT" describe pod -l "app=$PROJECT" || true
  exit 1
}

log "Waiting for deployment readiness"
kubectl -n "$PROJECT" rollout status "deployment/$PROJECT" --timeout=900s

log "Checking deployment and pod state"
kubectl -n "$PROJECT" get deployment "$PROJECT"
kubectl -n "$PROJECT" get pods -o wide

log "Deleting namespace"
kubectl delete namespace "$PROJECT" --wait=false

log "agentctl smoke test passed"
