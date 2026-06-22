#!/usr/bin/env bash
# setup-k3s-sandbox-worker.sh
# Join an x86_64 host to an existing k3s cluster and enable sandbox runtimes

set -euo pipefail

SCRIPT_NAME="$(basename "$0")"
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
K3S_AGENT_CONFIG="/etc/rancher/k3s/config.yaml"
CONTAINERD_TMPL_V2="/var/lib/rancher/k3s/agent/etc/containerd/config.toml.tmpl"
CONTAINERD_TMPL_V3="/var/lib/rancher/k3s/agent/etc/containerd/config-v3.toml.tmpl"
NODE_NAME="${K3S_NODE_NAME:-$(hostname -s)}"
RESTART_NEEDED=false
SERVER_ONLY_CONFIG_KEYS=(
  "write-kubeconfig"
  "write-kubeconfig-mode"
  "cluster-init"
  "disable-apiserver"
  "disable-controller-manager"
  "disable-scheduler"
  "etcd-arg"
  "kube-apiserver-arg"
  "kube-controller-manager-arg"
  "kube-scheduler-arg"
)

log() {
  printf '[%s] %s\n' "$SCRIPT_NAME" "$*"
}

fail() {
  printf '[%s] ERROR: %s\n' "$SCRIPT_NAME" "$*" >&2
  exit 1
}

fail_missing_join_input() {
  cat >&2 <<'EOF'
[setup-k3s-sandbox-worker.sh] ERROR: Missing k3s worker join settings.

Set these environment variables before running this script:

  export K3S_URL=https://<control-plane-host-or-ip>:6443
  export K3S_TOKEN='<server-node-token>'

On the control-plane node, you can print the values with:

  ./scripts/operations/print-k3s-worker-join-info.sh

Then run this worker setup again, for example:

  sudo K3S_URL=https://128.178.122.44:6443 \
       K3S_TOKEN='K10...' \
       ./scripts/operations/setup-k3s-sandbox-worker.sh
EOF
  exit 1
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

config_contains_server_only_keys() {
  [[ -f "$K3S_AGENT_CONFIG" ]] || return 1
  local key
  for key in "${SERVER_ONLY_CONFIG_KEYS[@]}"; do
    if grep -Eq "^[[:space:]]*${key}:" "$K3S_AGENT_CONFIG"; then
      return 0
    fi
  done
  return 1
}

preflight() {
  [[ $EUID -eq 0 ]] || fail "Run this script with sudo or as root"
  [[ "$(uname -m)" == "x86_64" ]] || fail "This worker path currently supports x86_64 only"
  grep -qE "vmx|svm" /proc/cpuinfo \
    || fail "VMX/SVM not found in /proc/cpuinfo. Enable hardware virtualisation in BIOS."
  [[ -n "${K3S_URL:-}" ]] || fail_missing_join_input
  [[ -n "${K3S_TOKEN:-}" ]] || fail_missing_join_input
  log "Preflight passed (root, x86_64, VMX available, join settings present)"
}

install_dependencies() {
  log "Installing dependencies..."
  apt-get update -qq
  apt-get install -y -qq apt-transport-https ca-certificates curl gnupg wget zstd
}

install_k3s_agent() {
  local tmp

  if command_exists k3s-agent; then
    log "k3s-agent already installed"
  else
    log "Installing k3s agent..."
    curl -sfL https://get.k3s.io | \
      K3S_URL="$K3S_URL" \
      K3S_TOKEN="$K3S_TOKEN" \
      INSTALL_K3S_EXEC="agent${K3S_AGENT_EXTRA_ARGS:+ ${K3S_AGENT_EXTRA_ARGS}}" \
      sh -
  fi

  mkdir -p /etc/rancher/k3s
  tmp="$(mktemp)"
  cat >"$tmp" <<EOF
server: ${K3S_URL}
token: ${K3S_TOKEN}
EOF

  if [[ -n "${K3S_NODE_NAME:-}" ]]; then
    cat >>"$tmp" <<EOF
node-name: ${K3S_NODE_NAME}
EOF
  fi

  if [[ -n "${K3S_NODE_LABELS:-}" ]]; then
    {
      printf 'node-label:\n'
      while IFS= read -r label; do
        [[ -n "$label" ]] || continue
        printf '  - %s\n' "$label"
      done <<< "$(printf '%s\n' "$K3S_NODE_LABELS" | tr ',' '\n')"
    } >>"$tmp"
  fi

  if config_contains_server_only_keys; then
    local backup_path
    backup_path="${K3S_AGENT_CONFIG}.before-worker.$(date +%Y%m%d%H%M%S)"
    cp "$K3S_AGENT_CONFIG" "$backup_path"
    log "Backed up incompatible server-side k3s config to ${backup_path}"
  fi

  if cmp -s "$tmp" "$K3S_AGENT_CONFIG" 2>/dev/null; then
    rm -f "$tmp"
    log "k3s-agent config already up to date"
  else
    mv "$tmp" "$K3S_AGENT_CONFIG"
    RESTART_NEEDED=true
    log "k3s-agent config written"
  fi
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
    log "Live k3s-agent containerd config does not yet include runsc; restart required"
    live_missing=true
  fi
  if ! live_containerd_config_has 'runtime_type = "io.containerd.runsc.v1"'; then
    log "Live k3s-agent containerd config does not yet include io.containerd.runsc.v1; restart required"
    live_missing=true
  fi
  if [[ "$live_missing" == true ]]; then
    RESTART_NEEDED=true
  fi
}

verify_live_runtime_registration() {
  log "Verifying live k3s-agent containerd runtime registration..."
  if ! live_containerd_config_has "[plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.'kata-qemu']" && \
     ! live_containerd_config_has '[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.kata-qemu]'; then
    fail "Live k3s-agent containerd config is missing kata-qemu runtime registration"
  fi
  if ! live_containerd_config_has "[plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.'runsc']" && \
     ! live_containerd_config_has '[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runsc]'; then
    fail "Live k3s-agent containerd config is missing runsc runtime registration"
  fi
  live_containerd_config_has 'runtime_type = "io.containerd.runsc.v1"' \
    || fail "Live k3s-agent containerd config is missing io.containerd.runsc.v1"
  command_exists runsc || fail "runsc is not installed on PATH"
  command_exists containerd-shim-runsc-v1 || fail "containerd-shim-runsc-v1 is not installed on PATH"
  log "Live runtime registration looks correct"
}

label_runtime_capabilities() {
  log "Labelling node ${NODE_NAME} with sandbox runtime capabilities..."
  k3s kubectl label node "${NODE_NAME}" \
    polaris.runtime.kata-qemu=true \
    polaris.runtime.kata-clh=true \
    polaris.runtime.kata-qemu-tdx=true \
    polaris.runtime.gvisor=true \
    --overwrite
}

restart_and_wait() {
  ensure_runtime_restart_needed
  if [[ "$RESTART_NEEDED" != true ]]; then
    log "No runtime changes detected; ensuring k3s-agent is running"
    systemctl enable --now k3s-agent
  else
    log "Restarting k3s-agent..."
    systemctl restart k3s-agent
  fi

  log "Waiting for k3s-agent to report active..."
  local i
  for i in $(seq 1 30); do
    if systemctl is-active --quiet k3s-agent; then
      log "k3s-agent is active"
      return
    fi
    sleep 3
    [[ $i -lt 30 ]] || fail "k3s-agent did not become active after 90s. Check: journalctl -u k3s-agent -n 50"
  done
}

main() {
  preflight
  install_dependencies
  install_k3s_agent
  install_kata
  install_gvisor
  configure_kata
  configure_containerd
  restart_and_wait
  verify_live_runtime_registration
  label_runtime_capabilities
  log "Worker setup complete. Verify from the server with: kubectl get nodes --show-labels"
}

main "$@"
