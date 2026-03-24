#!/usr/bin/env bash
# setup-k3s-kata-worker.sh
# Join an x86_64 Debian host to an existing k3s cluster and enable Kata runtimes

set -euo pipefail

SCRIPT_NAME="$(basename "$0")"
KATA_VERSION="3.28.0"
KATA_TARBALL="kata-static-${KATA_VERSION}-amd64.tar.zst"
KATA_URL="https://github.com/kata-containers/kata-containers/releases/download/${KATA_VERSION}/${KATA_TARBALL}"
KATA_RUNTIME="/opt/kata/bin/kata-runtime"
KATA_SHIM="/opt/kata/bin/containerd-shim-kata-v2"
KATA_SHIM_LINK="/usr/local/bin/containerd-shim-kata-v2"
K3S_AGENT_CONFIG="/etc/rancher/k3s/config.yaml"
CONTAINERD_TMPL="/var/lib/rancher/k3s/agent/etc/containerd/config.toml.tmpl"
RESTART_NEEDED=false

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
  [[ "$(uname -m)" == "x86_64" ]] || fail "This worker path currently supports x86_64 only"
  grep -qE "vmx|svm" /proc/cpuinfo \
    || fail "VMX/SVM not found in /proc/cpuinfo. Enable hardware virtualisation in BIOS."
  [[ -n "${K3S_URL:-}" ]] || fail "Set K3S_URL to your existing k3s server URL (for example https://server:6443)"
  [[ -n "${K3S_TOKEN:-}" ]] || fail "Set K3S_TOKEN to the server node token"
  log "Preflight passed (root, x86_64, VMX available, join settings present)"
}

install_dependencies() {
  log "Installing dependencies..."
  apt-get update -qq
  apt-get install -y -qq curl zstd
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

configure_containerd() {
  local tmp
  tmp="$(mktemp)"
  cat >"$tmp" <<'EOF'
version = 2

[plugins."io.containerd.grpc.v1.cri".cni]
  bin_dir = "/var/lib/rancher/k3s/data/current/bin"
  conf_dir = "/var/lib/rancher/k3s/agent/etc/cni/net.d"

[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.runc]
  runtime_type = "io.containerd.runc.v2"

[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.kata-qemu]
  runtime_type = "io.containerd.kata.v2"
  [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.kata-qemu.options]
    ConfigPath = "/opt/kata/share/defaults/kata-containers/configuration-qemu.toml"

[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.kata-clh]
  runtime_type = "io.containerd.kata.v2"
  [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.kata-clh.options]
    ConfigPath = "/opt/kata/share/defaults/kata-containers/configuration-clh.toml"

[plugins."io.containerd.grpc.v1.cri".containerd.runtimes.kata-qemu-tdx]
  runtime_type = "io.containerd.kata.v2"
  [plugins."io.containerd.grpc.v1.cri".containerd.runtimes.kata-qemu-tdx.options]
    ConfigPath = "/opt/kata/share/defaults/kata-containers/configuration-qemu-tdx.toml"
EOF

  if cmp -s "$tmp" "$CONTAINERD_TMPL" 2>/dev/null; then
    log "containerd template already up to date"
    rm -f "$tmp"
  else
    mkdir -p "$(dirname "$CONTAINERD_TMPL")"
    mv "$tmp" "$CONTAINERD_TMPL"
    log "containerd template written"
    RESTART_NEEDED=true
  fi
}

restart_and_wait() {
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
  configure_containerd
  restart_and_wait
  log "Worker setup complete. Verify from the server with: kubectl get nodes -o wide"
}

main "$@"
