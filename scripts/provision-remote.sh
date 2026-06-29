#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" = "" ]; then
  echo "Usage: $0 <remote-host> [remote-app-dir] [remote-env-file] [remote-data-root] [remote-netfs-export-root]" >&2
  echo "Prereqs: ssh access, sudo-capable remote user, host-level nginx gateway, and real production secrets ready for the remote env file." >&2
  exit 1
fi

REMOTE_HOST="$1"
REMOTE_APP_DIR="${2:-/srv/polaris/app}"
REMOTE_ENV_FILE="${3:-/etc/polaris/polaris.env}"
REMOTE_ENV_DIR="$(dirname "${REMOTE_ENV_FILE}")"
REMOTE_DATA_ROOT="${4:-/srv/polaris/data}"
REMOTE_NETFS_EXPORT_ROOT="${5:-/exports/polaris/workspaces}"
REMOTE_ACTIVE_COLOR_FILE="${REMOTE_ENV_DIR}/active-color"
REMOTE_UPSTREAM_FILE="/etc/nginx/conf.d/polaris-gateway-upstream.conf"
RSYNC_RSH="${RSYNC_RSH:-ssh}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "${ROOT_DIR}"

ssh "${REMOTE_HOST}" "set -euo pipefail
if [ \"\$(id -u)\" -eq 0 ]; then
  SUDO=''
else
  SUDO='sudo'
fi

\${SUDO} apt-get update
\${SUDO} apt-get install -y docker.io docker-compose-plugin nginx rsync curl git ca-certificates gnupg nfs-kernel-server rpcbind
\${SUDO} systemctl enable --now docker
\${SUDO} systemctl enable --now nginx
\${SUDO} systemctl enable --now rpcbind
\${SUDO} systemctl enable --now nfs-kernel-server

current_major=\"\$(node -p 'process.versions.node.split(\".\")[0]' 2>/dev/null || echo 0)\"
if [ \"\${current_major}\" -lt 22 ]; then
  \${SUDO} mkdir -p /etc/apt/keyrings /etc/apt/sources.list.d
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | \${SUDO} gpg --dearmor --batch --yes --no-tty -o /etc/apt/keyrings/nodesource.gpg
  printf 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main\n' \
    | \${SUDO} tee /etc/apt/sources.list.d/nodesource.list >/dev/null
  \${SUDO} apt-get update
  \${SUDO} apt-get install -y nodejs
fi

if ! command -v pnpm >/dev/null 2>&1; then
  if command -v corepack >/dev/null 2>&1; then
    \${SUDO} corepack enable
    \${SUDO} corepack prepare pnpm@10.33.0 --activate
  else
    \${SUDO} npm install -g pnpm@10.33.0
  fi
fi

\${SUDO} mkdir -p '${REMOTE_APP_DIR}' '${REMOTE_ENV_DIR}' '${REMOTE_DATA_ROOT}/users' '${REMOTE_DATA_ROOT}/state' '${REMOTE_DATA_ROOT}/workspaces' '${REMOTE_NETFS_EXPORT_ROOT}'
\${SUDO} mountpoint -q '${REMOTE_NETFS_EXPORT_ROOT}' || \${SUDO} mount --bind '${REMOTE_DATA_ROOT}/workspaces' '${REMOTE_NETFS_EXPORT_ROOT}'
\${SUDO} grep -qs \"${REMOTE_DATA_ROOT}/workspaces ${REMOTE_NETFS_EXPORT_ROOT} none bind 0 0\" /etc/fstab || \
  printf '%s\n' '${REMOTE_DATA_ROOT}/workspaces ${REMOTE_NETFS_EXPORT_ROOT} none bind 0 0' | \${SUDO} tee -a /etc/fstab >/dev/null
\${SUDO} grep -qs \"${REMOTE_NETFS_EXPORT_ROOT} 127.0.0.1/32(rw,fsid=0,no_subtree_check,no_root_squash,sync)\" /etc/exports || \
  printf '%s\n' '${REMOTE_NETFS_EXPORT_ROOT} 127.0.0.1/32(rw,fsid=0,no_subtree_check,no_root_squash,sync)' | \${SUDO} tee -a /etc/exports >/dev/null
\${SUDO} exportfs -ra
\${SUDO} chown -R \"\$(id -un)\":\"\$(id -gn)\" '${REMOTE_APP_DIR}' '${REMOTE_ENV_DIR}' '${REMOTE_DATA_ROOT}'
"

rsync -az \
  -e "${RSYNC_RSH}" \
  ./.env.prod.example "${REMOTE_HOST}:${REMOTE_APP_DIR}/.env.prod.example"
rsync -az \
  -e "${RSYNC_RSH}" \
  ./deploy/ "${REMOTE_HOST}:${REMOTE_APP_DIR}/deploy/"

ssh "${REMOTE_HOST}" "set -euo pipefail
if [ ! -f '${REMOTE_ENV_FILE}' ]; then
  cp '${REMOTE_APP_DIR}/.env.prod.example' '${REMOTE_ENV_FILE}'
fi

if ! grep -q '^POLARIS_DATA_ROOT=' '${REMOTE_ENV_FILE}'; then
  printf '\nPOLARIS_DATA_ROOT=%s\n' '${REMOTE_DATA_ROOT}' >> '${REMOTE_ENV_FILE}'
fi

if [ -d '${REMOTE_APP_DIR}/config/users' ] && [ -z \"\$(find '${REMOTE_DATA_ROOT}/users' -mindepth 1 -maxdepth 1 2>/dev/null)\" ]; then
  rsync -a '${REMOTE_APP_DIR}/config/users/' '${REMOTE_DATA_ROOT}/users/'
fi

if [ -d '${REMOTE_APP_DIR}/config/state' ] && [ -z \"\$(find '${REMOTE_DATA_ROOT}/state' -mindepth 1 -maxdepth 1 2>/dev/null)\" ]; then
  rsync -a '${REMOTE_APP_DIR}/config/state/' '${REMOTE_DATA_ROOT}/state/'
fi

if [ ! -f '${REMOTE_ACTIVE_COLOR_FILE}' ]; then
  printf 'blue\n' > '${REMOTE_ACTIVE_COLOR_FILE}'
fi

if [ ! -f '${REMOTE_UPSTREAM_FILE}' ]; then
  cp '${REMOTE_APP_DIR}/deploy/nginx/polaris-upstream.blue.conf' '${REMOTE_UPSTREAM_FILE}'
fi

printf '%s\n' \
  'remote provisioning: ok' \
  'next steps:' \
  '1. Fill real values into ${REMOTE_ENV_FILE}' \
  '2. Production data root: ${REMOTE_DATA_ROOT}' \
  '3. Update the host-level gateway for the Polaris vhost so it includes ${REMOTE_UPSTREAM_FILE} and uses proxy_pass $polaris_upstream;' \
  '4. Run nginx -t && nginx -s reload on the remote host' \
  '5. From your local machine, run: bash ./scripts/cd-remote.sh ${REMOTE_HOST}' \
"
