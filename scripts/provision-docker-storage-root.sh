#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  provision-docker-storage-root.sh --verify --mount-path <path>
  provision-docker-storage-root.sh --reset --image-path <path> --mount-path <path> --size-gib <integer> [--probe-image <image>]

The --reset mode destroys the current default Docker data root. It creates an
XFS filesystem backed by a preallocated image, mounts it with project quotas,
configures Docker to use that mount, and verifies a bounded writable layer.
Use it only for an explicitly disposable host or after an independent backup.
EOF
}

fail() {
  printf 'docker storage root: %s\n' "$*" >&2
  exit 1
}

require_value() {
  local option="$1" value="${2:-}"
  [ -n "${value}" ] || fail "${option} requires a value"
}

require_absolute_path() {
  local label="$1" value="$2"
  [[ "${value}" == /* ]] || fail "${label} must be an absolute path"
  [[ "${value}" != *[[:space:]]* ]] \
    || fail "${label} must not contain whitespace"
}

require_tool() {
  command -v "$1" >/dev/null 2>&1 || fail "${1} is required"
}

verify_storage_backend() {
  local docker_driver docker_root mount_info storage_filesystem storage_options

  require_tool docker
  require_tool findmnt
  docker_driver="$(docker info --format '{{.Driver}}')" \
    || fail "unable to inspect Docker storage driver"
  docker_root="$(docker info --format '{{.DockerRootDir}}')" \
    || fail "unable to inspect Docker root directory"
  [ "${docker_root}" = "${mount_path}" ] \
    || fail "Docker root ${docker_root} does not match configured mount ${mount_path}"
  mount_info="$(findmnt -T "${docker_root}" -no FSTYPE,OPTIONS 2>/dev/null)" \
    || fail "unable to inspect Docker root filesystem"
  read -r storage_filesystem storage_options <<< "${mount_info}"
  if [ "${docker_driver}" != "overlay2" ] \
    || [ "${storage_filesystem}" != "xfs" ] \
    || ! printf '%s' "${storage_options}" | grep -Eq '(^|,)(pquota|prjquota)(,|$)'; then
    fail "Docker must use overlay2 on xfs with pquota or prjquota"
  fi
}

validate_docker_configuration() {
  local daemon_config="/etc/docker/daemon.json" docker_exec_start

  require_tool node
  if [ -e "${daemon_config}" ] && [ ! -f "${daemon_config}" ]; then
    fail "Docker daemon configuration is not a regular file: ${daemon_config}"
  fi
  if [ -f "${daemon_config}" ]; then
    node - "${daemon_config}" <<'NODE'
const fs = require("node:fs");

const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!config || Array.isArray(config) || typeof config !== "object") {
  throw new Error("Docker daemon configuration must be a JSON object");
}
if (config["data-root"] && config["data-root"] !== "/var/lib/docker") {
  throw new Error("Docker daemon configuration already declares a non-default data-root");
}
NODE
  fi
  docker_exec_start="$(systemctl show --property=ExecStart --value docker.service)" \
    || fail "unable to inspect the Docker service command line"
  [[ "${docker_exec_start}" != *--data-root* ]] \
    || fail "Docker service already sets --data-root outside daemon.json"
}

write_docker_daemon_config() {
  local daemon_config="/etc/docker/daemon.json"
  local backup_config=""

  require_tool node
  install -d -m 0755 /etc/docker
  if [ -f "${daemon_config}" ]; then
    backup_config="${daemon_config}.before-polaris-storage.$(date -u +%Y%m%dT%H%M%SZ)"
    cp -a "${daemon_config}" "${backup_config}"
  fi
  node - "${daemon_config}" "${mount_path}" <<'NODE'
const fs = require("node:fs");

const [configPath, dataRoot] = process.argv.slice(2);
let config = {};
if (fs.existsSync(configPath)) {
  config = JSON.parse(fs.readFileSync(configPath, "utf8"));
}
if (!config || Array.isArray(config) || typeof config !== "object") {
  throw new Error("Docker daemon configuration must be a JSON object");
}
if (config["data-root"] && config["data-root"] !== dataRoot) {
  throw new Error("Docker daemon configuration already declares a different data-root");
}
config["data-root"] = dataRoot;
const temporaryPath = `${configPath}.polaris-storage.${process.pid}`;
fs.writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
fs.renameSync(temporaryPath, configPath);
NODE
  chmod 0600 "${daemon_config}"
  if [ -n "${backup_config}" ]; then
    printf 'docker storage root: backed up %s\n' "${backup_config}"
  fi
}

write_mount_configuration() {
  local fstab_line dropin_dir="/etc/systemd/system/docker.service.d"

  fstab_line="${image_path} ${mount_path} xfs loop,pquota 0 0"
  if grep -Fq " ${mount_path} " /etc/fstab; then
    fail "/etc/fstab already has an entry for ${mount_path}"
  fi
  printf '%s\n' "${fstab_line}" >> /etc/fstab

  install -d -m 0755 "${dropin_dir}"
  printf '%s\n' \
    '[Unit]' \
    "RequiresMountsFor=${mount_path}" \
    > "${dropin_dir}/polaris-storage-root.conf"
}

exercise_writable_layer_limit() {
  local probe_output probe_status

  docker pull "${probe_image}" >/dev/null
  probe_output="$(mktemp)"
  set +e
  docker run --rm --network none --storage-opt size=64m "${probe_image}" \
    sh -c 'dd if=/dev/zero of=/quota-probe bs=1M count=80 conv=fsync' \
    >"${probe_output}" 2>&1
  probe_status=$?
  set -e
  if [ "${probe_status}" -eq 0 ] \
    || ! grep -Eqi '(no space left on device|enospc)' "${probe_output}"; then
    sed -n '1,120p' "${probe_output}" >&2 || true
    rm -f "${probe_output}"
    fail "Docker did not enforce the 64 MiB writable-layer probe"
  fi
  rm -f "${probe_output}"
}

mode=""
image_path=""
mount_path=""
size_gib=""
probe_image="busybox:1.36.1"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --verify)
      [ -z "${mode}" ] || fail "choose exactly one of --verify or --reset"
      mode="verify"
      shift
      ;;
    --reset)
      [ -z "${mode}" ] || fail "choose exactly one of --verify or --reset"
      mode="reset"
      shift
      ;;
    --image-path)
      require_value "$1" "${2:-}"
      image_path="$2"
      shift 2
      ;;
    --mount-path)
      require_value "$1" "${2:-}"
      mount_path="$2"
      shift 2
      ;;
    --size-gib)
      require_value "$1" "${2:-}"
      size_gib="$2"
      shift 2
      ;;
    --probe-image)
      require_value "$1" "${2:-}"
      probe_image="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

[ -n "${mode}" ] || {
  usage >&2
  exit 1
}
require_absolute_path "--mount-path" "${mount_path}"

if [ "${mode}" = "verify" ]; then
  verify_storage_backend
  printf 'docker storage root: verified %s\n' "${mount_path}"
  exit 0
fi

[ "$(id -u)" -eq 0 ] || fail "--reset must run as root"
require_absolute_path "--image-path" "${image_path}"
[[ "${size_gib}" =~ ^[1-9][0-9]*$ ]] \
  && [ "${size_gib}" -le 1024 ] \
  || fail "--size-gib must be an integer between 1 and 1024"
case "${image_path}" in
  "${mount_path}"/*) fail "--image-path must be outside --mount-path" ;;
  "${mount_path}") fail "--image-path must be different from --mount-path" ;;
esac
case "${image_path}" in
  /var/lib/docker/*) fail "--image-path must be outside the default Docker root" ;;
esac

for tool in docker findmnt mkfs.xfs fallocate systemctl mount mountpoint node; do
  require_tool "${tool}"
done

docker_root="$(docker info --format '{{.DockerRootDir}}')" \
  || fail "unable to inspect the current Docker root"
[ "${docker_root}" = "/var/lib/docker" ] \
  || fail "--reset only supports the default current Docker root /var/lib/docker"
validate_docker_configuration
[ ! -e "${image_path}" ] || fail "--image-path already exists: ${image_path}"
install -d -m 0755 "$(dirname "${image_path}")" "${mount_path}"
mountpoint -q "${mount_path}" && fail "--mount-path is already mounted"
[ -z "$(find "${mount_path}" -mindepth 1 -maxdepth 1 -print -quit)" ] \
  || fail "--mount-path must be empty"

required_kib=$((size_gib * 1024 * 1024))
available_kib="$(df -Pk "$(dirname "${image_path}")" | awk 'NR == 2 { print $4 }')"
[[ "${available_kib}" =~ ^[0-9]+$ ]] \
  || fail "unable to determine free space for ${image_path}"
[ "${available_kib}" -gt "${required_kib}" ] \
  || fail "not enough free space to preallocate ${size_gib} GiB at ${image_path}"
fallocate -l "${size_gib}G" "${image_path}"
mkfs.xfs -f -n ftype=1 "${image_path}" >/dev/null

printf '%s\n' \
  'docker storage root: resetting the current Docker root at /var/lib/docker' \
  "docker storage root: provisioning ${size_gib} GiB XFS image at ${image_path}"
systemctl stop docker.service
systemctl stop docker.socket 2>/dev/null || true
if systemctl is-active --quiet docker.service; then
  fail "Docker service is still active after stop"
fi
rm -rf --one-file-system "${docker_root}"
install -d -m 0711 "${docker_root}"
write_mount_configuration
write_docker_daemon_config
systemctl daemon-reload
mount "${mount_path}"
systemctl start docker.service
verify_storage_backend
exercise_writable_layer_limit
printf 'docker storage root: ready at %s with an enforced writable-layer probe\n' "${mount_path}"
