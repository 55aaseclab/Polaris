#!/usr/bin/env bash

set -euo pipefail

SCRIPT_NAME="$(basename "$0")"
LOCAL_BIN_DIR="${LOCAL_BIN_DIR:-$HOME/.local/bin}"
KREW_ROOT_DIR="${KREW_ROOT:-$HOME/.krew}"
KREW_BIN_DIR="${KREW_ROOT_DIR}/bin"
KUBECTL_VERSION="${KUBECTL_VERSION:-}"

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

detect_pkg_manager() {
  if command_exists apt-get; then
    printf 'apt\n'
  elif command_exists dnf; then
    printf 'dnf\n'
  elif command_exists brew; then
    printf 'brew\n'
  else
    printf 'none\n'
  fi
}

ensure_base_packages() {
  local manager
  manager="$(detect_pkg_manager)"

  case "$manager" in
    apt)
      sudo apt-get update || log "apt-get update had errors, continuing"
      sudo apt-get install -y curl git tar gzip ca-certificates rsync nodejs npm
      ;;
    dnf)
      sudo dnf install -y curl git tar gzip ca-certificates rsync nodejs npm
      ;;
    brew)
      brew install curl git rsync node
      ;;
    none)
      ;;
  esac
}

ensure_required_commands() {
  local missing
  missing=()

  for cmd in curl git tar gzip mktemp uname sed; do
    if ! command_exists "$cmd"; then
      missing+=("$cmd")
    fi
  done

  if [[ "${#missing[@]}" -gt 0 ]]; then
    fail "missing required commands: ${missing[*]}"
  fi
}

ensure_pnpm() {
  if command_exists pnpm; then
    log "pnpm already installed"
    return
  fi

  if command_exists corepack; then
    log "Installing pnpm via corepack"
    corepack enable
    corepack prepare pnpm@latest --activate
    return
  fi

  if command_exists npm; then
    log "Installing pnpm via npm"
    npm install -g pnpm
    return
  fi

  fail "pnpm installation failed: neither corepack nor npm is available"
}

detect_os() {
  local os
  os="$(uname | tr '[:upper:]' '[:lower:]')"
  case "$os" in
    linux|darwin)
      printf '%s\n' "$os"
      ;;
    *)
      fail "unsupported OS: $os"
      ;;
  esac
}

detect_arch() {
  local arch
  arch="$(uname -m)"
  case "$arch" in
    x86_64|amd64)
      printf 'amd64\n'
      ;;
    arm64|aarch64)
      printf 'arm64\n'
      ;;
    armv7l)
      printf 'arm\n'
      ;;
    *)
      fail "unsupported architecture: $arch"
      ;;
  esac
}

append_path_line() {
  local file line
  file="$1"
  line="$2"

  touch "$file"
  if ! grep -F "$line" "$file" >/dev/null 2>&1; then
    printf '\n%s\n' "$line" >> "$file"
  fi
}

ensure_shell_path() {
  mkdir -p "$LOCAL_BIN_DIR" "$KREW_BIN_DIR"
  append_path_line "$HOME/.zshrc" 'export PATH="$HOME/.local/bin:${KREW_ROOT:-$HOME/.krew}/bin:$PATH"'
  append_path_line "$HOME/.bashrc" 'export PATH="$HOME/.local/bin:${KREW_ROOT:-$HOME/.krew}/bin:$PATH"'
  export PATH="$LOCAL_BIN_DIR:$KREW_BIN_DIR:$PATH"
}

resolve_kubectl_version() {
  if [[ -n "$KUBECTL_VERSION" ]]; then
    printf '%s\n' "$KUBECTL_VERSION"
    return
  fi

  curl -fsSL "https://dl.k8s.io/release/stable.txt"
}

install_kubectl() {
  local os arch version url target
  os="$(detect_os)"
  arch="$(detect_arch)"
  version="$(resolve_kubectl_version)"
  target="${LOCAL_BIN_DIR}/kubectl"

  log "Installing kubectl ${version} into ${LOCAL_BIN_DIR}"
  url="https://dl.k8s.io/release/${version}/bin/${os}/${arch}/kubectl"
  curl -fsSL "$url" -o "$target"
  chmod +x "$target"
}

install_krew() {
  local os arch temp_dir krew_archive krew_binary
  os="$(detect_os)"
  arch="$(detect_arch)"
  temp_dir="$(mktemp -d)"
  krew_archive="krew-${os}_${arch}.tar.gz"
  krew_binary="krew-${os}_${arch}"

  log "Installing krew into ${KREW_ROOT_DIR}"
  curl -fsSL \
    "https://github.com/kubernetes-sigs/krew/releases/latest/download/${krew_archive}" \
    -o "${temp_dir}/${krew_archive}"
  tar -xzf "${temp_dir}/${krew_archive}" -C "$temp_dir"
  "${temp_dir}/${krew_binary}" install krew
  rm -rf "$temp_dir"
}

ensure_kubectl() {
  if command_exists kubectl; then
    log "kubectl already installed"
    return
  fi

  install_kubectl
}

ensure_krew() {
  if command_exists kubectl-krew || kubectl krew version >/dev/null 2>&1; then
    log "krew already installed"
    return
  fi

  install_krew
}

ensure_virt_plugin() {
  if kubectl krew list 2>/dev/null | awk '{print $1}' | grep -Fx virt >/dev/null; then
    log "kubectl virt already installed"
    return
  fi

  log "Installing kubectl virt"
  kubectl krew install virt
}

verify_install() {
  kubectl version --client >/dev/null
  kubectl krew version >/dev/null
  kubectl virt help >/dev/null
  pnpm --version >/dev/null
  log "Verified kubectl, krew, kubectl virt, and pnpm"
}

main() {
  ensure_base_packages
  ensure_required_commands
  ensure_shell_path
  ensure_pnpm
  ensure_kubectl
  ensure_krew
  ensure_virt_plugin
  verify_install
  log 'Open a new shell or run: export PATH="$HOME/.local/bin:${KREW_ROOT:-$HOME/.krew}/bin:$PATH"'
}

main "$@"
