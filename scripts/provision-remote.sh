#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" = "" ]; then
  echo "Usage: $0 <remote-host> [remote-app-dir] [remote-data-root] [remote-netfs-export-root]" >&2
  echo "Prereqs: ssh access, sudo-capable remote user, host-level nginx gateway, and real production secrets ready for the remote env file." >&2
  exit 1
fi

REMOTE_HOST="$1"
REMOTE_APP_DIR="${2:-/srv/polaris/app}"
REMOTE_DATA_ROOT="${3:-/srv/polaris/data}"
REMOTE_NETFS_EXPORT_ROOT="${4:-/exports/polaris/workspaces}"
REMOTE_ENV_FILE="/etc/polaris/polaris.env"
REMOTE_ENV_DIR="$(dirname "${REMOTE_ENV_FILE}")"
REMOTE_ACTIVE_COLOR_FILE="${REMOTE_ENV_DIR}/active-color"
REMOTE_UPSTREAM_FILE="/etc/nginx/snippets/polaris-gateway-upstream.conf"
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
\${SUDO} apt-get install -y docker.io docker-compose-plugin nginx rsync curl git ca-certificates gnupg nfs-kernel-server rpcbind socat
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

\${SUDO} mkdir -p '${REMOTE_APP_DIR}' '${REMOTE_ENV_DIR}' '${REMOTE_DATA_ROOT}/users' '${REMOTE_DATA_ROOT}/state' '${REMOTE_DATA_ROOT}/workspaces' '${REMOTE_NETFS_EXPORT_ROOT}' /etc/nginx/snippets
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
  ./scripts/run-polaris-executor-host.sh "${REMOTE_HOST}:${REMOTE_APP_DIR}/scripts/run-polaris-executor-host.sh"
rsync -az \
  -e "${RSYNC_RSH}" \
  ./scripts/run-polaris-executor-bridge-proxy.sh "${REMOTE_HOST}:${REMOTE_APP_DIR}/scripts/run-polaris-executor-bridge-proxy.sh"
rsync -az \
  -e "${RSYNC_RSH}" \
  ./deploy/ "${REMOTE_HOST}:${REMOTE_APP_DIR}/deploy/"

ssh "${REMOTE_HOST}" "set -euo pipefail
upsert_env_line() {
  local key=\"\$1\"
  local value=\"\$2\"
  local file=\"\$3\"
  local temp_file
  temp_file=\"\$(mktemp)\"
  awk -v key=\"\${key}\" -v value=\"\${value}\" '
    BEGIN { updated = 0 }
    index(\$0, key \"=\") == 1 {
      print key \"=\" value
      updated = 1
      next
    }
    { print }
    END {
      if (updated == 0) {
        print key \"=\" value
      }
    }
  ' \"\${file}\" > \"\${temp_file}\"
  mv \"\${temp_file}\" \"\${file}\"
}

generate_executor_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
    return 0
  fi
  python3 - <<'PY'
import secrets
print(secrets.token_hex(32))
PY
}

if [ ! -f '${REMOTE_ENV_FILE}' ]; then
  cp '${REMOTE_APP_DIR}/.env.prod.example' '${REMOTE_ENV_FILE}'
fi

upsert_env_line 'POLARIS_DATA_ROOT' '${REMOTE_DATA_ROOT}' '${REMOTE_ENV_FILE}'
upsert_env_line 'POLARIS_NETFS_LOCAL_EXPORT_ROOT' '${REMOTE_NETFS_EXPORT_ROOT}' '${REMOTE_ENV_FILE}'
upsert_env_line 'POLARIS_EXECUTOR_HOST' '127.0.0.1' '${REMOTE_ENV_FILE}'

if ! grep -q '^POLARIS_EXECUTOR_SHARED_SECRET=' '${REMOTE_ENV_FILE}' \
  || grep -q '^POLARIS_EXECUTOR_SHARED_SECRET=$' '${REMOTE_ENV_FILE}' \
  || grep -q '^POLARIS_EXECUTOR_SHARED_SECRET=change-me-to-a-long-random-secret$' '${REMOTE_ENV_FILE}'; then
  upsert_env_line 'POLARIS_EXECUTOR_SHARED_SECRET' \"\$(generate_executor_secret)\" '${REMOTE_ENV_FILE}'
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

cat > /etc/systemd/system/polaris-executor.service <<EOF
[Unit]
Description=Polaris host executor
After=network.target docker.service
Wants=docker.service

[Service]
Type=simple
WorkingDirectory=${REMOTE_APP_DIR}
Environment=POLARIS_ENV_FILE=${REMOTE_ENV_FILE}
ExecStart=/bin/bash ${REMOTE_APP_DIR}/scripts/run-polaris-executor-host.sh ${REMOTE_ENV_FILE}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/polaris-executor-bridge-proxy.service <<EOF
[Unit]
Description=Polaris executor bridge proxy
After=network.target docker.service polaris-executor.service
Wants=docker.service polaris-executor.service

[Service]
Type=simple
WorkingDirectory=${REMOTE_APP_DIR}
ExecStart=/bin/bash ${REMOTE_APP_DIR}/scripts/run-polaris-executor-bridge-proxy.sh
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/polaris-container-runtime-cleanup.service <<EOF
[Unit]
Description=Polaris remote container runtime cleanup
After=docker.service containerd.service
Wants=docker.service containerd.service

[Service]
Type=oneshot
WorkingDirectory=${REMOTE_APP_DIR}
ExecStart=/bin/bash ${REMOTE_APP_DIR}/scripts/cleanup-remote-container-runtime.sh
Environment=LEASE_RETENTION_HOURS=24
Environment=DOCKER_PRUNE_UNTIL=24h
EOF

cat > /etc/systemd/system/polaris-container-runtime-cleanup.timer <<EOF
[Unit]
Description=Run Polaris remote container runtime cleanup daily

[Timer]
OnCalendar=*-*-* 04:40:00
Persistent=true
Unit=polaris-container-runtime-cleanup.service

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable polaris-executor.service
systemctl enable polaris-executor-bridge-proxy.service
systemctl enable polaris-container-runtime-cleanup.timer
systemctl restart polaris-executor.service
systemctl restart polaris-executor-bridge-proxy.service
systemctl restart polaris-container-runtime-cleanup.timer

nginx_dump=\"\$(nginx -T 2>/dev/null || true)\"
missing=0

if ! printf '%s\n' \"\$nginx_dump\" | grep -Fq 'include ${REMOTE_UPSTREAM_FILE};'; then
  echo 'remote provisioning: nginx check failed: missing include ${REMOTE_UPSTREAM_FILE};' >&2
  missing=1
fi

if ! printf '%s\n' \"\$nginx_dump\" | grep -Fq 'proxy_pass \$polaris_upstream;'; then
  echo 'remote provisioning: nginx check failed: missing proxy_pass \$polaris_upstream;' >&2
  missing=1
fi

if [ \"\$missing\" -eq 1 ]; then
  printf '%s\n' \
    'next steps:' \
    '1. Fill real values into ${REMOTE_ENV_FILE}' \
    '   Required: Clerk publishable and secret keys' \
    '2. Production data root: ${REMOTE_DATA_ROOT}' \
    '3. In the Polaris host nginx server block, add: include ${REMOTE_UPSTREAM_FILE};' \
    '4. In the same location / block, use: proxy_pass \$polaris_upstream;' \
    '5. Run nginx -t && nginx -s reload on the remote host' \
    '6. Re-run: bash ./scripts/provision-remote.sh ${REMOTE_HOST}' >&2
  exit 2
fi

printf '%s\n' \
  'remote provisioning: ok' \
  'nginx gateway check: ok' \
  'next steps:' \
  '1. Fill real values into ${REMOTE_ENV_FILE}' \
  '   Required: Clerk publishable and secret keys' \
  '2. Production data root: ${REMOTE_DATA_ROOT}' \
  '3. Run nginx -t && nginx -s reload on the remote host if you changed the upstream file' \
  '4. From your local machine, run: bash ./scripts/cd-remote.sh ${REMOTE_HOST}' \
"
