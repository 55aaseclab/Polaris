#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${1:-.env.deploy}"
ACTION="${2:-status}"

if [ ! -f "${ENV_FILE}" ]; then
  echo "Missing env file: ${ENV_FILE}" >&2
  exit 1
fi

set -a
. "${ENV_FILE}"
set +a

EXECUTOR_PORT="${POLARIS_EXECUTOR_PORT:-8788}"
EXECUTOR_HOST="${POLARIS_EXECUTOR_HOST:-127.0.0.1}"
RUNTIME_DIR=".runtime/polaris-executor"
PID_FILE="${RUNTIME_DIR}/executor.pid"
LOG_FILE="${RUNTIME_DIR}/executor.log"
ENV_MARKER_FILE="${RUNTIME_DIR}/env-file"
COMMAND_PATTERN="apps/polaris/dist/scripts/polaris.js executor"

resolve_docker_bridge_gateway() {
  docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null \
    || ip -4 addr show docker0 2>/dev/null | awk '/inet / {print $2}' | cut -d/ -f1 | head -n1
}

if printf '%s' "${POLARIS_EXECUTOR_BASE_URL:-}" | grep -Eq '^https?://host\.docker\.internal([/:]|$)' \
  && [ "${EXECUTOR_HOST}" = "127.0.0.1" ]; then
  DOCKER_BRIDGE_GATEWAY="$(resolve_docker_bridge_gateway || true)"
  if [ -n "${DOCKER_BRIDGE_GATEWAY}" ]; then
    EXECUTOR_HOST="${DOCKER_BRIDGE_GATEWAY}"
  fi
fi

mkdir -p "${RUNTIME_DIR}"

is_pid_running() {
  local pid="${1:-}"
  [ -n "${pid}" ] && kill -0 "${pid}" 2>/dev/null
}

read_managed_pid() {
  if [ -f "${PID_FILE}" ]; then
    tr -d '[:space:]' < "${PID_FILE}"
  fi
}

remove_runtime_state() {
  rm -f "${PID_FILE}" "${ENV_MARKER_FILE}"
}

wait_for_pid_exit() {
  local pid="${1:-}"
  local attempts=40
  while is_pid_running "${pid}"; do
    attempts=$((attempts - 1))
    if [ "${attempts}" -le 0 ]; then
      return 1
    fi
    sleep 0.25
  done
  return 0
}

kill_pid_gracefully() {
  local pid="${1:-}"
  if ! is_pid_running "${pid}"; then
    return 0
  fi
  kill "${pid}" 2>/dev/null || true
  if wait_for_pid_exit "${pid}"; then
    return 0
  fi
  kill -9 "${pid}" 2>/dev/null || true
  wait_for_pid_exit "${pid}" || true
}

find_matching_pids() {
  pgrep -f "${COMMAND_PATTERN}" 2>/dev/null || true
}

stop_matching_processes() {
  local managed_pid
  managed_pid="$(read_managed_pid || true)"
  if [ -n "${managed_pid}" ]; then
    kill_pid_gracefully "${managed_pid}"
  fi

  local pid
  while read -r pid; do
    [ -n "${pid}" ] || continue
    if [ -n "${managed_pid}" ] && [ "${pid}" = "${managed_pid}" ]; then
      continue
    fi
    kill_pid_gracefully "${pid}"
  done < <(find_matching_pids)

  remove_runtime_state
}

healthcheck_url() {
  printf 'http://%s:%s/health' "${EXECUTOR_HOST}" "${EXECUTOR_PORT}"
}

wait_for_health() {
  local url
  url="$(healthcheck_url)"
  local attempts=40
  while [ "${attempts}" -gt 0 ]; do
    if curl -fsS "${url}" >/dev/null 2>&1; then
      return 0
    fi
    attempts=$((attempts - 1))
    sleep 0.25
  done
  return 1
}

start_executor() {
  local managed_pid
  managed_pid="$(read_managed_pid || true)"
  if [ -n "${managed_pid}" ] && is_pid_running "${managed_pid}"; then
    echo "Polaris executor already running on http://${EXECUTOR_HOST}:${EXECUTOR_PORT} (pid ${managed_pid})"
    return 0
  fi

  stop_matching_processes

  : > "${LOG_FILE}"
  printf '%s\n' "${ENV_FILE}" > "${ENV_MARKER_FILE}"

  nohup node apps/polaris/dist/scripts/polaris.js executor "${EXECUTOR_PORT}" "${EXECUTOR_HOST}" \
    >> "${LOG_FILE}" 2>&1 &
  local pid=$!
  printf '%s\n' "${pid}" > "${PID_FILE}"

  if wait_for_health; then
    echo "Polaris executor started on http://${EXECUTOR_HOST}:${EXECUTOR_PORT} (pid ${pid})"
    return 0
  fi

  echo "Polaris executor failed to become healthy; recent log:" >&2
  tail -n 40 "${LOG_FILE}" >&2 || true
  stop_matching_processes
  exit 1
}

stop_executor() {
  local managed_pid
  managed_pid="$(read_managed_pid || true)"
  if [ -z "${managed_pid}" ] && [ -z "$(find_matching_pids)" ]; then
    echo "Polaris executor is not running"
    return 0
  fi
  stop_matching_processes
  echo "Polaris executor stopped"
}

status_executor() {
  local managed_pid
  managed_pid="$(read_managed_pid || true)"
  if [ -n "${managed_pid}" ] && is_pid_running "${managed_pid}"; then
    echo "Polaris executor running on http://${EXECUTOR_HOST}:${EXECUTOR_PORT} (pid ${managed_pid})"
    echo "Log: ${LOG_FILE}"
    return 0
  fi
  local matched_pids
  matched_pids="$(find_matching_pids | tr '\n' ' ' | xargs 2>/dev/null || true)"
  if [ -n "${matched_pids}" ]; then
    echo "Polaris executor running outside managed pidfile (pids: ${matched_pids})"
    return 0
  fi
  echo "Polaris executor is not running"
}

case "${ACTION}" in
  start)
    start_executor
    ;;
  stop)
    stop_executor
    ;;
  restart)
    stop_matching_processes
    start_executor
    ;;
  status)
    status_executor
    ;;
  *)
    echo "Usage: bash ./scripts/manage-polaris-executor-host.sh [env-file] [start|stop|restart|status]" >&2
    exit 1
    ;;
esac
