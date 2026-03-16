#!/usr/bin/env bash

set -euo pipefail

SCRIPT_NAME="$(basename "$0")"

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

test_mode_enabled() {
  [[ "${GEEK_ENV_TEST_MODE:-0}" == "1" ]]
}

resolve_system_path() {
  local path
  path="$1"

  if test_mode_enabled && [[ -n "${GEEK_ENV_SYSTEM_ROOT:-}" ]]; then
    printf '%s%s\n' "$GEEK_ENV_SYSTEM_ROOT" "$path"
  else
    printf '%s\n' "$path"
  fi
}

write_system_file() {
  local target
  target="$(resolve_system_path "$1")"

  if test_mode_enabled; then
    mkdir -p "$(dirname "$target")"
    cat >"$target"
    return
  fi

  sudo mkdir -p "$(dirname "$target")"
  sudo tee "$target" >/dev/null
}

detect_pkg_manager() {
  if command_exists apt-get; then
    echo "apt"
  elif command_exists dnf; then
    echo "dnf"
  else
    fail "Unsupported system. Configure ZRAM manually."
  fi
}

install_packages() {
  local manager
  manager="$(detect_pkg_manager)"

  case "$manager" in
    apt)
      sudo apt-get update || log "apt-get update had errors (non-fatal), continuing"
      sudo apt-get install -y zram-tools
      ;;
    dnf)
      sudo dnf install -y zram-generator-defaults
      ;;
  esac
}

configure_apt() {
  write_system_file /etc/default/zramswap <<'EOF'
ALGO=zstd
PERCENT=100
PRIORITY=100
EOF

  if test_mode_enabled || ! command_exists systemctl; then
    log "Skipping zramswap service activation"
    return
  fi

  sudo systemctl enable --now zramswap.service
}

configure_dnf() {
  write_system_file /etc/systemd/zram-generator.conf.d/geek-env.conf <<'EOF'
[zram0]
zram-size = ram
compression-algorithm = zstd
swap-priority = 100
fs-type = swap
EOF

  if test_mode_enabled || ! command_exists systemctl; then
    log "Skipping zram generator activation"
    return
  fi

  sudo systemctl daemon-reload
  sudo systemctl restart systemd-zram-setup@zram0.service
}

main() {
  install_packages

  case "$(detect_pkg_manager)" in
    apt)
      configure_apt
      ;;
    dnf)
      configure_dnf
      ;;
  esac

  log "ZRAM swap enabled with zstd compression."

  if test_mode_enabled || ! command_exists swapon; then
    return
  fi

  swapon --show
}

main "$@"
