#!/usr/bin/env bash
set -euo pipefail

LEASE_RETENTION_HOURS="${LEASE_RETENTION_HOURS:-24}"
DOCKER_PRUNE_UNTIL="${DOCKER_PRUNE_UNTIL:-24h}"

log() {
  printf '[cleanup-container-runtime] %s\n' "$*"
}

have_cmd() {
  command -v "$1" >/dev/null 2>&1
}

epoch_now() {
  date +%s
}

lease_epoch() {
  date -d "$1" +%s
}

delete_stale_moby_leases() {
  if ! have_cmd ctr; then
    log "skip ctr lease cleanup: ctr not found"
    return 0
  fi

  if ! systemctl is-active --quiet containerd; then
    log "skip ctr lease cleanup: containerd is not active"
    return 0
  fi

  local now
  local retention_seconds
  local line
  local lease_id
  local created_at
  local created_epoch
  local age_seconds
  local deleted=0

  now="$(epoch_now)"
  retention_seconds="$((LEASE_RETENTION_HOURS * 3600))"

  while read -r lease_id created_at _; do
    [ -n "${lease_id}" ] || continue
    [ -n "${created_at}" ] || continue
    created_epoch="$(lease_epoch "${created_at}")" || continue
    age_seconds="$((now - created_epoch))"
    if [ "${age_seconds}" -lt "${retention_seconds}" ]; then
      continue
    fi
    ctr -n moby leases delete "${lease_id}" >/dev/null 2>&1 || true
    deleted="$((deleted + 1))"
  done < <(ctr -n moby leases ls | awk 'NR > 1 { print $1, $2, $3 }')

  log "deleted stale moby leases: ${deleted}"
}

prune_docker_runtime() {
  if ! have_cmd docker; then
    log "skip docker prune: docker not found"
    return 0
  fi

  if ! systemctl is-active --quiet docker; then
    log "skip docker prune: docker is not active"
    return 0
  fi

  docker container prune -f --filter "until=${DOCKER_PRUNE_UNTIL}" >/dev/null
  docker image prune -af --filter "until=${DOCKER_PRUNE_UNTIL}" >/dev/null
  docker builder prune -af --filter "until=${DOCKER_PRUNE_UNTIL}" >/dev/null 2>&1 || true
}

report_usage() {
  log "disk: $(df -h / | awk 'NR == 2 { print $3 "/" $2 " avail=" $4 }')"
  if [ -d /var/lib/containerd ]; then
    log "containerd: $(du -sh /var/lib/containerd | awk '{print $1}')"
  fi
  if [ -d /var/lib/docker ]; then
    log "docker: $(du -sh /var/lib/docker | awk '{print $1}')"
  fi
  if have_cmd docker; then
    docker system df || true
  fi
}

main() {
  log "start"
  report_usage
  delete_stale_moby_leases
  prune_docker_runtime
  sleep 3
  report_usage
  log "done"
}

main "$@"
