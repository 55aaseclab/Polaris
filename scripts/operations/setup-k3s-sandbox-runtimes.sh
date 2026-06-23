#!/usr/bin/env bash
# setup-k3s-sandbox-runtimes.sh
# Idempotent setup of k3s with Kata Containers and gVisor on Debian

set -euo pipefail

SCRIPT_NAME="$(basename "$0")"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KATA_VERSION="3.28.0"
KATA_TARBALL="kata-static-${KATA_VERSION}-amd64.tar.zst"
KATA_URL="https://github.com/kata-containers/kata-containers/releases/download/${KATA_VERSION}/${KATA_TARBALL}"
KATA_RUNTIME="/opt/kata/bin/kata-runtime"
KATA_SHIM="/opt/kata/bin/containerd-shim-kata-v2"
KATA_SHIM_LINK="/usr/local/bin/containerd-shim-kata-v2"
KATA_CONFIG_DIR="/opt/kata/share/defaults/kata-containers"
KATA_QEMU_CONFIG="${KATA_CONFIG_DIR}/configuration-qemu.toml"
KATA_CLH_CONFIG="${KATA_CONFIG_DIR}/configuration-clh.toml"
KATA_QEMU_TDX_CONFIG="${KATA_CONFIG_DIR}/configuration-qemu-tdx.toml"
GVISOR_KEYRING="/usr/share/keyrings/gvisor-archive-keyring.gpg"
GVISOR_APT_SOURCE="/etc/apt/sources.list.d/gvisor.list"
K3S_CONFIG="/etc/rancher/k3s/config.yaml"
CONTAINERD_TMPL_V2="/var/lib/rancher/k3s/agent/etc/containerd/config.toml.tmpl"
CONTAINERD_TMPL_V3="/var/lib/rancher/k3s/agent/etc/containerd/config-v3.toml.tmpl"
NODE_NAME="$(hostname -s)"
RESTART_NEEDED=false
K3S_ACTIVE_ENTER_TS_BEFORE=""

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

k3s_active_enter_timestamp() {
  systemctl show k3s --property=ActiveEnterTimestampMonotonic --value 2>/dev/null || true
}

preflight() {
  [[ $EUID -eq 0 ]] || fail "Run this script with sudo or as root"
  grep -qE "vmx|svm" /proc/cpuinfo \
    || fail "VMX/SVM not found in /proc/cpuinfo. Enable hardware virtualisation in BIOS."
  log "Preflight passed (root, VMX available)"
}

install_dependencies() {
  log "Installing dependencies..."
  apt-get update -qq
  apt-get install -y -qq apt-transport-https ca-certificates curl gnupg wget zstd
}

install_k3s() {
  K3S_ACTIVE_ENTER_TS_BEFORE="$(k3s_active_enter_timestamp)"
  if command_exists k3s; then
    log "k3s already installed ($(k3s --version | head -1))"
  else
    log "Installing k3s..."
    curl -sfL https://get.k3s.io | sh -
  fi

  log "Configuring k3s kubeconfig permissions..."
  mkdir -p /etc/rancher/k3s
  cat >"$K3S_CONFIG" <<'EOF'
write-kubeconfig-mode: "0644"
EOF
}

install_kata() {
  if [[ -x "$KATA_RUNTIME" ]]; then
    log "Kata Containers already installed ($($KATA_RUNTIME --version 2>&1 | head -1))"
  else
    log "Downloading Kata Containers ${KATA_VERSION}..."
    local tmp
    tmp="$(mktemp -d)"
    curl -fsSL "$KATA_URL" -o "$tmp/$KATA_TARBALL"
    log "Extracting Kata Containers..."
    tar --use-compress-program=unzstd -xf "$tmp/$KATA_TARBALL" -C /
    rm -rf "$tmp"
    log "Kata Containers extracted to /opt/kata"
    RESTART_NEEDED=true
  fi

  log "Symlinking containerd shim..."
  ln -sf "$KATA_SHIM" "$KATA_SHIM_LINK"

  log "Verifying Kata runtime..."
  "$KATA_RUNTIME" check \
    && log "Kata runtime check passed" \
    || log "WARN: kata-runtime check had warnings (see above)"
}

install_gvisor() {
  local arch source_line repo_changed=false
  arch="$(dpkg --print-architecture)"
  source_line="deb [arch=${arch} signed-by=${GVISOR_KEYRING}] https://storage.googleapis.com/gvisor/releases release main"

  log "Configuring gVisor apt repository..."
  mkdir -p "$(dirname "$GVISOR_KEYRING")"
  curl -fsSL https://gvisor.dev/archive.key | gpg --dearmor -o "$GVISOR_KEYRING.tmp"
  if cmp -s "$GVISOR_KEYRING.tmp" "$GVISOR_KEYRING" 2>/dev/null; then
    rm -f "$GVISOR_KEYRING.tmp"
  else
    mv "$GVISOR_KEYRING.tmp" "$GVISOR_KEYRING"
    repo_changed=true
  fi

  if [[ -f "$GVISOR_APT_SOURCE" ]] && grep -Fxq "$source_line" "$GVISOR_APT_SOURCE"; then
    :
  else
    printf '%s\n' "$source_line" >"$GVISOR_APT_SOURCE"
    repo_changed=true
  fi

  if [[ "$repo_changed" == true ]]; then
    apt-get update -qq
  fi

  if command_exists runsc && command_exists containerd-shim-runsc-v1; then
    log "gVisor already installed ($(runsc --version 2>/dev/null | head -1 || echo runsc))"
  else
    log "Installing gVisor..."
    apt-get install -y -qq runsc
    RESTART_NEEDED=true
  fi
}

patch_kata_config() {
  local target_config="$1"
  local tmp
  tmp="$(mktemp)"
  python3 - "$target_config" <<'PY' >"$tmp"
from pathlib import Path
import re
import sys

target = Path(sys.argv[1])
text = target.read_text()

patterns = {
    r"(?m)^enable_debug = (true|false)$": "enable_debug = true",
    r"(?m)^static_sandbox_resource_mgmt = (true|false)$": "static_sandbox_resource_mgmt = true",
}

for pattern, replacement in patterns.items():
    text, count = re.subn(pattern, replacement, text, count=1)
    if count != 1:
        raise SystemExit(f"failed to update {pattern!r} in {target}")

sys.stdout.write(text)
PY

  if cmp -s "$tmp" "$target_config" 2>/dev/null; then
    log "$(basename "$target_config") already up to date"
    rm -f "$tmp"
  else
    mkdir -p "$(dirname "$target_config")"
    mv "$tmp" "$target_config"
    log "Wrote $(basename "$target_config")"
    RESTART_NEEDED=true
  fi
}

configure_kata() {
  patch_kata_config "$KATA_QEMU_CONFIG"
  patch_kata_config "$KATA_CLH_CONFIG"
  patch_kata_config "$KATA_QEMU_TDX_CONFIG"
}

configure_containerd() {
  local tmp
  tmp="$(mktemp)"
  cat >"$tmp" <<'EOF'
{{ template "base" . }}

[plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.'kata-qemu']
  runtime_type = "io.containerd.kata.v2"

[plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.'kata-qemu'.options]
  ConfigPath = "/opt/kata/share/defaults/kata-containers/configuration-qemu.toml"

[plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.'kata-clh']
  runtime_type = "io.containerd.kata.v2"

[plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.'kata-clh'.options]
  ConfigPath = "/opt/kata/share/defaults/kata-containers/configuration-clh.toml"

[plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.'kata-qemu-tdx']
  runtime_type = "io.containerd.kata.v2"

[plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.'kata-qemu-tdx'.options]
  ConfigPath = "/opt/kata/share/defaults/kata-containers/configuration-qemu-tdx.toml"

[plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.'runsc']
  runtime_type = "io.containerd.runsc.v1"
EOF

  if cmp -s "$tmp" "$CONTAINERD_TMPL_V3" 2>/dev/null; then
    log "containerd v3 template already up to date"
    rm -f "$tmp"
  else
    mkdir -p "$(dirname "$CONTAINERD_TMPL_V3")"
    mv "$tmp" "$CONTAINERD_TMPL_V3"
    log "containerd v3 template written"
    RESTART_NEEDED=true
  fi

  if [[ -f "$CONTAINERD_TMPL_V2" ]]; then
    rm -f "$CONTAINERD_TMPL_V2"
    log "Removed legacy containerd v2 template to avoid precedence confusion"
    RESTART_NEEDED=true
  fi
}

live_containerd_config_has() {
  local pattern="$1"
  grep -Fq "$pattern" /var/lib/rancher/k3s/agent/etc/containerd/config.toml 2>/dev/null
}

ensure_runtime_restart_needed() {
  local live_missing=false
  if ! live_containerd_config_has "[plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.'runsc']" && \
     ! live_containerd_config_has '[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runsc]'; then
    log "Live k3s containerd config does not yet include runsc; restart required"
    live_missing=true
  fi
  if ! live_containerd_config_has 'runtime_type = "io.containerd.runsc.v1"'; then
    log "Live k3s containerd config does not yet include io.containerd.runsc.v1; restart required"
    live_missing=true
  fi
  if [[ "$live_missing" == true ]]; then
    RESTART_NEEDED=true
  fi
}

restart_and_wait() {
  ensure_runtime_restart_needed
  if [[ "$RESTART_NEEDED" != true ]]; then
    log "No changes detected; skipping k3s restart"
    return
  fi

  log "Restarting k3s..."
  systemctl restart k3s

  local after_restart
  after_restart="$(k3s_active_enter_timestamp)"
  if [[ -n "$K3S_ACTIVE_ENTER_TS_BEFORE" && -n "$after_restart" && "$after_restart" == "$K3S_ACTIVE_ENTER_TS_BEFORE" ]]; then
    fail "k3s restart was requested but systemd ActiveEnterTimestampMonotonic did not change"
  fi

  log "Waiting for node to be Ready..."
  local i status
  for i in $(seq 1 30); do
    status="$(k3s kubectl get nodes --no-headers 2>/dev/null | awk '{print $2}' || true)"
    if [[ "$status" == "Ready" ]]; then
      log "Node is Ready"
      return
    fi
    sleep 3
    [[ $i -lt 30 ]] || fail "Node did not become Ready after 90s. Check: journalctl -u k3s -n 50"
  done
}

verify_live_runtime_registration() {
  log "Verifying live k3s containerd runtime registration..."
  if ! live_containerd_config_has "[plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.'kata-qemu']" && \
     ! live_containerd_config_has '[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.kata-qemu]'; then
    fail "Live k3s containerd config is missing kata-qemu runtime registration"
  fi
  if ! live_containerd_config_has "[plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.'runsc']" && \
     ! live_containerd_config_has '[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runsc]'; then
    fail "Live k3s containerd config is missing runsc runtime registration"
  fi
  live_containerd_config_has 'runtime_type = "io.containerd.runsc.v1"' \
    || fail "Live k3s containerd config is missing io.containerd.runsc.v1"
  command_exists runsc || fail "runsc is not installed on PATH"
  command_exists containerd-shim-runsc-v1 || fail "containerd-shim-runsc-v1 is not installed on PATH"
  log "Live runtime registration looks correct"
}

apply_runtimeclass() {
  log "Labelling node ${NODE_NAME} with sandbox runtime capabilities..."
  k3s kubectl label node "${NODE_NAME}" \
    polaris.runtime.kata-qemu=true \
    polaris.runtime.kata-clh=true \
    polaris.runtime.kata-qemu-tdx=true \
    polaris.runtime.gvisor=true \
    --overwrite

  log "Applying RuntimeClasses..."
  # handler is immutable; delete stale entries before applying
  k3s kubectl delete runtimeclass kata-qemu kata-clh kata-qemu-tdx gvisor --ignore-not-found=true
  k3s kubectl apply -f - <<'EOF'
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: kata-qemu
handler: kata-qemu
scheduling:
  nodeSelector:
    polaris.runtime.kata-qemu: "true"
---
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: kata-clh
handler: kata-clh
scheduling:
  nodeSelector:
    polaris.runtime.kata-clh: "true"
---
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: kata-qemu-tdx
handler: kata-qemu-tdx
scheduling:
  nodeSelector:
    polaris.runtime.kata-qemu-tdx: "true"
---
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: gvisor
handler: runsc
scheduling:
  nodeSelector:
    polaris.runtime.gvisor: "true"
EOF
  log "RuntimeClasses applied (kata-qemu, kata-clh, kata-qemu-tdx, gvisor)"
}

main() {
  preflight
  install_dependencies
  install_k3s
  install_kata
  install_gvisor
  configure_kata
  configure_containerd
  restart_and_wait
  verify_live_runtime_registration
  apply_runtimeclass
  "$SCRIPT_DIR/run-kata-smoke-test.sh"
  GVISOR_SMOKE_RUNTIME_CLASS=gvisor "$SCRIPT_DIR/run-gvisor-smoke-test.sh"
  log "Setup complete. Run: kubectl get nodes && kubectl get runtimeclass"
}

main "$@"
