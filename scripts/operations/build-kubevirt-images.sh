#!/usr/bin/env bash
set -euo pipefail

log() {
  printf '[build-kubevirt-images.sh] %s\n' "$*"
}

usage() {
  cat <<'EOF'
Usage:
  ./scripts/operations/build-kubevirt-images.sh <rootdisk-image-ref> [options]

Options:
  --namespace <ns>              Kubernetes namespace that holds the VM.
                                Default: demo
  --vm-name <name>              KubeVirt VM name to snapshot.
                                Default: demo-vm
  --workspace-image <ref>       Workspace OCI image that should be the source lineage
                                for the VM environment.
                                Default: ttl.sh/polaris-demo-debian13-1782126452:24h
  --build-workspace-image       Rebuild the workspace OCI image from the Dockerfile
                                before snapshotting the VM.
  --dockerfile <path>           Dockerfile used for workspace-image rebuild.
                                Default: user-profile Dockerfile when present,
                                otherwise config/users/100000000000000001/docker/workspace-prebuilt.Dockerfile
  --context <path>              Docker build context for workspace-image rebuild.
                                Default: repo root
  --workspace-image-output <ref>
                                Tag to assign when rebuilding the workspace OCI image.
                                Default: value of --workspace-image

Examples:
  ./scripts/operations/build-kubevirt-images.sh \
    ttl.sh/polaris-demo-kubevirt-rootdisk-1234567890:24h

  ./scripts/operations/build-kubevirt-images.sh \
    ttl.sh/polaris-demo-kubevirt-rootdisk-1234567890:24h \
    --build-workspace-image \
    --workspace-image-output ttl.sh/polaris-demo-debian13-1234567890:24h

Behavior:
  1. Optionally rebuild the workspace OCI image from the shared Dockerfile.
  2. Verify the running VM is using the expected workspace-image lineage through
     the saved Polaris KubeVirt spec.
  3. Snapshot the running VM rootdisk qcow2, flatten its backing chain inside the
     launcher pod, and package the standalone qcow2 as a KubeVirt-compatible
     containerDisk image at /disk/disk.img.

Notes:
  - This script still snapshots a running VM rootdisk, but it now treats the
    Dockerfile-driven workspace image as the source of truth for the environment
    lineage instead of an arbitrary live VM state.
  - The VM you snapshot should already have completed any one-time provisioning
    you want baked into the KubeVirt rootdisk.
EOF
}

ROOTDISK_IMAGE_REF=""
NAMESPACE="demo"
VM_NAME="demo-vm"
WORKSPACE_IMAGE_REF="ttl.sh/polaris-demo-debian13-1782126452:24h"
BUILD_WORKSPACE_IMAGE=0
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
KUBEVIRT_SPEC_PATH="${REPO_ROOT}/config/users/100000000000000001/projects/demo/kubevirt.agent.yaml"
DEFAULT_DOCKERFILE_PATH="${REPO_ROOT}/config/users/100000000000000001/docker/workspace-prebuilt.Dockerfile"
DOCKERFILE_PATH=""
BUILD_CONTEXT="${REPO_ROOT}"
WORKSPACE_IMAGE_OUTPUT=""

resolve_workspace_user_profile_id() {
  sed -n "s/^user_profile: ['\"]\\{0,1\\}\\([^'\"]*\\)['\"]\\{0,1\\}$/\\1/p" \
    "${KUBEVIRT_SPEC_PATH}" | head -n 1
}

resolve_default_dockerfile_path() {
  local user_profile_id
  local user_dockerfile

  user_profile_id="$(resolve_workspace_user_profile_id)"
  if [[ -n "${user_profile_id}" ]]; then
    user_dockerfile="${REPO_ROOT}/config/users/${user_profile_id}/docker/workspace-prebuilt.Dockerfile"
    if [[ -f "${user_dockerfile}" ]]; then
      printf '%s\n' "${user_dockerfile}"
      return
    fi
  fi

  printf '%s\n' "${DEFAULT_DOCKERFILE_PATH}"
}

if [[ $# -lt 1 ]]; then
  usage
  exit 1
fi

ROOTDISK_IMAGE_REF="$1"
shift

while [[ $# -gt 0 ]]; do
  case "$1" in
    --namespace)
      NAMESPACE="$2"
      shift 2
      ;;
    --vm-name)
      VM_NAME="$2"
      shift 2
      ;;
    --workspace-image)
      WORKSPACE_IMAGE_REF="$2"
      shift 2
      ;;
    --build-workspace-image)
      BUILD_WORKSPACE_IMAGE=1
      shift
      ;;
    --dockerfile)
      DOCKERFILE_PATH="$2"
      shift 2
      ;;
    --context)
      BUILD_CONTEXT="$2"
      shift 2
      ;;
    --workspace-image-output)
      WORKSPACE_IMAGE_OUTPUT="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      log "unknown argument: $1"
      usage
      exit 1
      ;;
  esac
done

if [[ -z "${WORKSPACE_IMAGE_OUTPUT}" ]]; then
  WORKSPACE_IMAGE_OUTPUT="${WORKSPACE_IMAGE_REF}"
fi

if [[ -z "${DOCKERFILE_PATH}" ]]; then
  DOCKERFILE_PATH="$(resolve_default_dockerfile_path)"
fi

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    log "missing required command: $1"
    exit 1
  fi
}

need_cmd kubectl
need_cmd docker
need_cmd qemu-img
need_cmd 7z

if [[ "${BUILD_WORKSPACE_IMAGE}" == "1" ]]; then
  log "Rebuilding workspace OCI image ${WORKSPACE_IMAGE_OUTPUT} from ${DOCKERFILE_PATH}..."
  docker build -f "${DOCKERFILE_PATH}" -t "${WORKSPACE_IMAGE_OUTPUT}" "${BUILD_CONTEXT}"
  if [[ "${WORKSPACE_IMAGE_OUTPUT}" == *"/"* || "${WORKSPACE_IMAGE_OUTPUT}" == *":"* ]]; then
    log "Pushing workspace OCI image ${WORKSPACE_IMAGE_OUTPUT}..."
    docker push "${WORKSPACE_IMAGE_OUTPUT}"
  fi
  WORKSPACE_IMAGE_REF="${WORKSPACE_IMAGE_OUTPUT}"
fi

SPEC_BASE_IMAGE="$(sed -n "s/^  base_image: //p" "${KUBEVIRT_SPEC_PATH}" | head -n 1 | tr -d '\r')"
if [[ -n "${SPEC_BASE_IMAGE}" && "${SPEC_BASE_IMAGE}" != "${WORKSPACE_IMAGE_REF}" ]]; then
  log "warning: kubevirt saved spec base_image is '${SPEC_BASE_IMAGE}', but requested workspace-image is '${WORKSPACE_IMAGE_REF}'"
  log "warning: snapshot provenance may not match the current saved spec unless you update the spec first"
fi

LAUNCHER_POD="$(kubectl -n "${NAMESPACE}" get pod -l "vm.kubevirt.io/name=${VM_NAME}" -o jsonpath='{.items[0].metadata.name}')"
if [[ -z "${LAUNCHER_POD}" ]]; then
  log "no launcher pod found for ${NAMESPACE}/${VM_NAME}"
  exit 1
fi

VMI_PHASE="$(kubectl -n "${NAMESPACE}" get vmi "${VM_NAME}" -o jsonpath='{.status.phase}' 2>/dev/null || true)"
COMPUTE_READY="$(kubectl -n "${NAMESPACE}" get pod "${LAUNCHER_POD}" -o jsonpath='{.status.containerStatuses[?(@.name=="compute")].ready}' 2>/dev/null || true)"
if [[ "${VMI_PHASE}" != "Running" && "${COMPUTE_READY}" != "true" ]]; then
  log "expected VMI ${NAMESPACE}/${VM_NAME} to be Running or launcher compute to be ready before snapshotting, got phase='${VMI_PHASE:-missing}' computeReady='${COMPUTE_READY:-missing}'"
  exit 1
fi

SCRATCH_ROOT="${PWD}/.tmp/kubevirt-rootdisk-build"
mkdir -p "${SCRATCH_ROOT}"
TMP_ROOT="$(mktemp -d "${SCRATCH_ROOT}/build-XXXXXX")"
cleanup() {
  rm -rf "${TMP_ROOT}"
}
trap cleanup EXIT

QCOW_PATH="${TMP_ROOT}/disk.img"
RAW_DISK_PATH="${TMP_ROOT}/disk.raw"
ROOTFS_RAW_PATH="${TMP_ROOT}/rootfs.img"
PATCH_ROOT="${TMP_ROOT}/rootfs-patch"
DOCKERFILE_OUT="${TMP_ROOT}/Dockerfile"
POD_FLAT_QCOW_PATH="/var/run/kubevirt-private/rootdisk-flat.qcow2"

patch_rootfs_guest() {
  local raw_disk_path="$1"
  local rootfs_raw_path="$2"
  local patch_root="$3"
  local offset_bytes
  local size_bytes
  local start_sector
  local sector_count

  read -r offset_bytes size_bytes < <(
    python3 -c '
import struct
import sys

path = sys.argv[1]
with open(path, "rb") as f:
    f.seek(512)
    header = f.read(92)
    if header[:8] != b"EFI PART":
        raise SystemExit("expected GPT disk image")
    entries_lba = struct.unpack("<Q", header[72:80])[0]
    entry_count = struct.unpack("<I", header[80:84])[0]
    entry_size = struct.unpack("<I", header[84:88])[0]
    f.seek(entries_lba * 512)
    data = f.read(entry_count * entry_size)

largest = None
for index in range(entry_count):
    entry = data[index * entry_size:(index + 1) * entry_size]
    if entry[:16] == b"\x00" * 16:
        continue
    first_lba = struct.unpack("<Q", entry[32:40])[0]
    last_lba = struct.unpack("<Q", entry[40:48])[0]
    size_bytes = (last_lba - first_lba + 1) * 512
    if largest is None or size_bytes > largest[1]:
        largest = (first_lba * 512, size_bytes)

if largest is None:
    raise SystemExit("could not find a usable GPT partition")

print(largest[0], largest[1])
' "${raw_disk_path}"
  )

  start_sector=$((offset_bytes / 512))
  sector_count=$((size_bytes / 512))

  log "Extracting rootfs partition at byte offset ${offset_bytes} (${size_bytes} bytes)..."
  dd if="${raw_disk_path}" of="${rootfs_raw_path}" bs=512 skip="${start_sector}" count="${sector_count}" status=none

  mkdir -p "${patch_root}"
  printf '%s\n' \
    '[Resolve]' \
    'DNS=1.1.1.1 8.8.8.8' \
    'FallbackDNS=1.0.0.1 8.8.4.4' \
    'DNSStubListener=yes' \
    > "${patch_root}/90-polaris-dns.conf"
  printf '%s\n' \
    'network:' \
    '  version: 2' \
    '  ethernets:' \
    '    all-en:' \
    '      match:' \
    '        name: "en*"' \
      '      dhcp4: true' \
      '      dhcp6: false' \
    '      optional: true' \
    > "${patch_root}/50-cloud-init.yaml"
  printf '%s\n' \
    '127.0.0.1	localhost' \
    '::1		localhost ip6-localhost ip6-loopback' \
    'ff02::1		ip6-allnodes' \
    'ff02::2		ip6-allrouters' \
    '104.21.45.99 relay.paseo.sh' \
    '172.67.212.223 relay.paseo.sh' \
    > "${patch_root}/hosts"
  printf '%s\n' \
    'nameserver 1.1.1.1' \
    'nameserver 8.8.8.8' \
    'nameserver 1.0.0.1' \
    'nameserver 8.8.4.4' \
    > "${patch_root}/resolv.conf"
  printf '%s\n' \
    'PermitRootLogin yes' \
    'PubkeyAuthentication yes' \
    'PasswordAuthentication yes' \
    'StrictModes no' \
    'PermitEmptyPasswords yes' \
    'UsePAM no' \
    > "${patch_root}/90-polaris-sshd.conf"
  printf '%s\n' \
    '[Service]' \
    'ExecStart=' \
    'ExecStart=-/sbin/agetty --autologin root --keep-baud 115200,57600,38400 %I $TERM' \
    > "${patch_root}/serial-getty-autologin.conf"
  printf '%s\n' \
    '#!/bin/sh' \
    'set -eu' \
    'mkdir -p /etc/ssh/sshd_config.d /etc/systemd/system/serial-getty@ttyS0.service.d' \
    'cp /tmp/90-polaris-sshd.conf /etc/ssh/sshd_config.d/90-polaris-sshd.conf' \
    'cp /tmp/serial-getty-autologin.conf /etc/systemd/system/serial-getty@ttyS0.service.d/autologin.conf' \
    "python3 - <<'PY'" \
    'from pathlib import Path' \
    'path = Path("/etc/shadow")' \
    'lines = []' \
    'for line in path.read_text().splitlines():' \
    '    if line.startswith("root:"):' \
    '        parts = line.split(":")' \
    '        parts[1] = ""' \
    '        line = ":".join(parts)' \
    '    lines.append(line)' \
    'path.write_text("\\n".join(lines) + "\\n")' \
    'PY' \
    > "${patch_root}/guest-firstboot.sh"

  log "Baking resolver defaults into extracted rootfs..."
  docker run --rm \
    -v "${TMP_ROOT}:/work" \
    debian:13 \
    bash -lc '
      set -euo pipefail
      export DEBIAN_FRONTEND=noninteractive
      apt-get update >/dev/null
      apt-get install -y e2fsprogs >/dev/null
      e2fsck -fy /work/rootfs.img >/dev/null || status=$?
      status=${status:-0}
      if [ "$status" -gt 1 ]; then
        exit "$status"
      fi
      debugfs -w -R "mkdir /etc/systemd/resolved.conf.d" /work/rootfs.img >/dev/null 2>&1 || true
      debugfs -w -R "mkdir /etc/netplan" /work/rootfs.img >/dev/null 2>&1 || true
      debugfs -w -R "write /work/rootfs-patch/90-polaris-dns.conf /etc/systemd/resolved.conf.d/90-polaris-dns.conf" /work/rootfs.img >/tmp/debugfs.log 2>&1
      debugfs -w -R "rm /etc/netplan/50-cloud-init.yaml" /work/rootfs.img >/dev/null 2>&1 || true
      debugfs -w -R "write /work/rootfs-patch/50-cloud-init.yaml /etc/netplan/50-cloud-init.yaml" /work/rootfs.img >/tmp/debugfs.log 2>&1
      debugfs -w -R "rm /etc/hosts" /work/rootfs.img >/dev/null 2>&1 || true
      debugfs -w -R "write /work/rootfs-patch/hosts /etc/hosts" /work/rootfs.img >/tmp/debugfs.log 2>&1
      debugfs -w -R "rm /etc/resolv.conf" /work/rootfs.img >/dev/null 2>&1 || true
      debugfs -w -R "write /work/rootfs-patch/resolv.conf /etc/resolv.conf" /work/rootfs.img >/tmp/debugfs.log 2>&1
      debugfs -w -R "mkdir /etc/ssh/sshd_config.d" /work/rootfs.img >/dev/null 2>&1 || true
      debugfs -w -R "mkdir /etc/systemd/system/serial-getty@ttyS0.service.d" /work/rootfs.img >/dev/null 2>&1 || true
      debugfs -w -R "write /work/rootfs-patch/90-polaris-sshd.conf /etc/ssh/sshd_config.d/90-polaris-sshd.conf" /work/rootfs.img >/tmp/debugfs.log 2>&1
      debugfs -w -R "write /work/rootfs-patch/serial-getty-autologin.conf /etc/systemd/system/serial-getty@ttyS0.service.d/autologin.conf" /work/rootfs.img >/tmp/debugfs.log 2>&1
      debugfs -w -R "write /work/rootfs-patch/guest-firstboot.sh /root/guest-firstboot.sh" /work/rootfs.img >/tmp/debugfs.log 2>&1
    '

  log "Writing patched rootfs partition back into raw disk..."
  dd if="${rootfs_raw_path}" of="${raw_disk_path}" bs=512 seek="${start_sector}" conv=notrunc status=none
}

log "Flattening rootdisk qcow2 backing chain inside launcher pod ${LAUNCHER_POD}..."
kubectl -n "${NAMESPACE}" exec "${LAUNCHER_POD}" -c compute -- \
  qemu-img convert -U -O qcow2 \
  /var/run/kubevirt-ephemeral-disks/disk-data/rootdisk/disk.qcow2 \
  "${POD_FLAT_QCOW_PATH}"

log "Copying flattened qcow2 out of launcher pod..."
kubectl -n "${NAMESPACE}" cp "${LAUNCHER_POD}:${POD_FLAT_QCOW_PATH}" "${QCOW_PATH}"
kubectl -n "${NAMESPACE}" exec "${LAUNCHER_POD}" -c compute -- rm -f "${POD_FLAT_QCOW_PATH}"

log "Converting flattened qcow2 to raw disk for rootfs patching..."
qemu-img convert -O raw "${QCOW_PATH}" "${RAW_DISK_PATH}"
patch_rootfs_guest "${RAW_DISK_PATH}" "${ROOTFS_RAW_PATH}" "${PATCH_ROOT}"
log "Converting patched raw disk back to qcow2..."
qemu-img convert -O qcow2 "${RAW_DISK_PATH}" "${QCOW_PATH}"

cat >"${DOCKERFILE_OUT}" <<'EOF'
FROM scratch
COPY disk.img /disk/disk.img
EOF

log "Building containerDisk image ${ROOTDISK_IMAGE_REF}..."
docker build -f "${DOCKERFILE_OUT}" -t "${ROOTDISK_IMAGE_REF}" "${TMP_ROOT}"

log "Pushing ${ROOTDISK_IMAGE_REF}..."
docker push "${ROOTDISK_IMAGE_REF}"

log "Done"
