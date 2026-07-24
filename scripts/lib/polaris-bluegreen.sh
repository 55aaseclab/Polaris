#!/usr/bin/env bash

set -euo pipefail

polaris_bluegreen_require_env_file() {
  local env_file="$1"
  if [ ! -f "${env_file}" ]; then
    echo "Env file not found: ${env_file}" >&2
    exit 1
  fi
}

polaris_bluegreen_active_color() {
  local active_color_file="$1"
  local active_color="blue"
  if [ -f "${active_color_file}" ]; then
    active_color="$(tr -d '[:space:]' < "${active_color_file}")"
  fi
  case "${active_color}" in
    blue|green)
      printf '%s\n' "${active_color}"
      ;;
    *)
      echo "Invalid active color in ${active_color_file}: ${active_color}" >&2
      exit 1
      ;;
  esac
}

polaris_bluegreen_inactive_color() {
  local color="$1"
  if [ "${color}" = "blue" ]; then
    printf 'green\n'
  else
    printf 'blue\n'
  fi
}

polaris_bluegreen_project_name() {
  local color="$1"
  printf 'polaris-%s\n' "${color}"
}

polaris_bluegreen_nginx_port() {
  local color="$1"
  if [ "${color}" = "blue" ]; then
    printf '%s\n' "${BLUE_NGINX_HTTP_PORT:-18080}"
  else
    printf '%s\n' "${GREEN_NGINX_HTTP_PORT:-28080}"
  fi
}

polaris_bluegreen_server_port() {
  local color="$1"
  if [ "${color}" = "blue" ]; then
    printf '%s\n' "${BLUE_POLARIS_SERVER_PORT:-18787}"
  else
    printf '%s\n' "${GREEN_POLARIS_SERVER_PORT:-28787}"
  fi
}

polaris_bluegreen_paseo_port() {
  local color="$1"
  if [ "${color}" = "blue" ]; then
    printf '%s\n' "${BLUE_PASEO_APP_PORT:-18082}"
  else
    printf '%s\n' "${GREEN_PASEO_APP_PORT:-28082}"
  fi
}

polaris_bluegreen_write_temp_env() {
  local source_env="$1"
  local color="$2"
  local target_env="$3"

  awk '
    BEGIN {
      skip["NGINX_HTTP_PORT"]=1
      skip["POLARIS_SERVER_PORT"]=1
      skip["PASEO_APP_PORT"]=1
      skip["POLARIS_SERVER_BIND_HOST"]=1
      skip["PASEO_APP_BIND_HOST"]=1
    }
    {
      split($0, parts, "=")
      key = parts[1]
      if (skip[key] == 1) {
        next
      }
      print
    }
  ' "${source_env}" > "${target_env}"

  cat >> "${target_env}" <<EOF
NGINX_HTTP_PORT=$(polaris_bluegreen_nginx_port "${color}")
POLARIS_SERVER_PORT=$(polaris_bluegreen_server_port "${color}")
PASEO_APP_PORT=$(polaris_bluegreen_paseo_port "${color}")
POLARIS_SERVER_BIND_HOST=127.0.0.1
PASEO_APP_BIND_HOST=127.0.0.1
EOF
}

polaris_bluegreen_wait_for_stack() {
  local port="$1"
  local timeout_seconds="${2:-240}"
  local started_at
  started_at="$(date +%s)"

  while true; do
    if curl -fsS "http://127.0.0.1:${port}/" >/dev/null 2>&1; then
      return 0
    fi

    if [ $(( $(date +%s) - started_at )) -ge "${timeout_seconds}" ]; then
      echo "Timed out waiting for Polaris stack on http://127.0.0.1:${port}" >&2
      return 1
    fi

    sleep 3
  done
}

polaris_bluegreen_switch_upstream() {
  local color="$1"
  local upstream_file="$2"
  local active_color_file="$3"
  local next_file
  local backup_file

  next_file="$(mktemp)"
  backup_file="$(mktemp)"

  if [ -f "${upstream_file}" ]; then
    cp "${upstream_file}" "${backup_file}"
  fi

  printf 'set $polaris_upstream http://127.0.0.1:%s;\n' "$(polaris_bluegreen_nginx_port "${color}")" > "${next_file}"
  install -m 0644 "${next_file}" "${upstream_file}"
  rm -f "${next_file}"

  if ! nginx -t || ! nginx -s reload; then
    if [ -s "${backup_file}" ]; then
      install -m 0644 "${backup_file}" "${upstream_file}"
      nginx -t >/dev/null 2>&1 || true
      nginx -s reload >/dev/null 2>&1 || true
    fi
    rm -f "${backup_file}"
    echo "Failed to switch nginx upstream to ${color}" >&2
    return 1
  fi

  rm -f "${backup_file}"
  printf '%s\n' "${color}" > "${active_color_file}"
}
