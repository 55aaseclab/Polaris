#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" = "" ]; then
  echo "Usage: $0 <remote-host> [remote-app-dir] [remote-data-root] [remote-netfs-export-root] [local-wanghai-dir] [remote-wanghai-dir]" >&2
  echo "Prereqs: ssh access, sudo-capable remote user, host-level nginx gateway, and real production secrets ready for the remote env file." >&2
  exit 1
fi

REMOTE_HOST="$1"
REMOTE_APP_DIR="${2:-/srv/polaris/app}"
REMOTE_DATA_ROOT="${3:-/srv/polaris/data}"
REMOTE_NETFS_EXPORT_ROOT="${4:-/exports/polaris/vaults}"
LOCAL_WANGHAI_DIR="${5:-}"
REMOTE_WANGHAI_DIR="${6:-/opt/wanghai}"
REMOTE_ENV_FILE="/etc/polaris/polaris.env"
REMOTE_ENV_DIR="$(dirname "${REMOTE_ENV_FILE}")"
REMOTE_ACTIVE_COLOR_FILE="${REMOTE_ENV_DIR}/active-color"
REMOTE_UPSTREAM_FILE="/etc/nginx/snippets/polaris-gateway-upstream.conf"
RSYNC_RSH="${RSYNC_RSH:-ssh}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ -z "${LOCAL_WANGHAI_DIR}" ] && [ -d "${ROOT_DIR}/../wanghai" ]; then
  LOCAL_WANGHAI_DIR="${ROOT_DIR}/../wanghai"
fi

if [ ! -f "${LOCAL_WANGHAI_DIR}/scripts/build-admin-portal-image.sh" ]; then
  echo "Missing Wanghai source. Pass [local-wanghai-dir] or place the repo at ../wanghai." >&2
  exit 1
fi

cd "${ROOT_DIR}"

ssh "${REMOTE_HOST}" "set -euo pipefail
if [ \"\$(id -u)\" -eq 0 ]; then
  SUDO=''
else
  SUDO='sudo'
fi
APP_USER=\"\$(id -un)\"
APP_GROUP=\"\$(id -gn)\"

install_root_file() {
  local target=\"\$1\"
  local temp_file
  temp_file=\"\$(mktemp)\"
  cat > \"\${temp_file}\"
  if [ -n \"\${SUDO}\" ]; then
    \${SUDO} install -m 0644 \"\${temp_file}\" \"\${target}\"
  else
    install -m 0644 \"\${temp_file}\" \"\${target}\"
  fi
  rm -f \"\${temp_file}\"
}

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
  if [ -n \"\${SUDO}\" ]; then
    \${SUDO} install -m 0644 \"\${temp_file}\" \"\${file}\"
  else
    install -m 0644 \"\${temp_file}\" \"\${file}\"
  fi
  rm -f \"\${temp_file}\"
}

\${SUDO} apt-get update
\${SUDO} apt-get install -y nginx rsync curl git ca-certificates gnupg nfs-kernel-server rpcbind

if ! command -v docker >/dev/null 2>&1; then
  if apt-cache policy docker-ce | awk '/Candidate:/ { print \$2 }' | grep -vq '^(none)\$'; then
    \${SUDO} apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
  else
    \${SUDO} apt-get install -y docker.io docker-compose-plugin
  fi
elif ! docker compose version >/dev/null 2>&1; then
  \${SUDO} apt-get install -y docker-compose-plugin
fi

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

\${SUDO} mkdir -p '${REMOTE_APP_DIR}' '${REMOTE_ENV_DIR}' '${REMOTE_DATA_ROOT}/users' '${REMOTE_DATA_ROOT}/state' '${REMOTE_DATA_ROOT}/vaults' '${REMOTE_DATA_ROOT}/backup-keys' '${REMOTE_NETFS_EXPORT_ROOT}' '${REMOTE_WANGHAI_DIR}' /etc/nginx/snippets
\${SUDO} mountpoint -q '${REMOTE_NETFS_EXPORT_ROOT}' || \${SUDO} mount --bind '${REMOTE_DATA_ROOT}/vaults' '${REMOTE_NETFS_EXPORT_ROOT}'
\${SUDO} grep -qs \"${REMOTE_DATA_ROOT}/vaults ${REMOTE_NETFS_EXPORT_ROOT} none bind 0 0\" /etc/fstab || \
  printf '%s\n' '${REMOTE_DATA_ROOT}/vaults ${REMOTE_NETFS_EXPORT_ROOT} none bind 0 0' | \${SUDO} tee -a /etc/fstab >/dev/null
\${SUDO} grep -qs \"${REMOTE_NETFS_EXPORT_ROOT} 127.0.0.1/32(rw,fsid=0,no_subtree_check,no_root_squash,sync)\" /etc/exports || \
  printf '%s\n' '${REMOTE_NETFS_EXPORT_ROOT} 127.0.0.1/32(rw,fsid=0,no_subtree_check,no_root_squash,sync)' | \${SUDO} tee -a /etc/exports >/dev/null
\${SUDO} exportfs -ra
\${SUDO} chown -R \"\${APP_USER}\":\"\${APP_GROUP}\" '${REMOTE_APP_DIR}' '${REMOTE_DATA_ROOT}' '${REMOTE_WANGHAI_DIR}'
\${SUDO} chmod 0700 '${REMOTE_DATA_ROOT}/backup-keys'
\${SUDO} chown root:\"\${APP_GROUP}\" '${REMOTE_ENV_DIR}'
\${SUDO} chmod 0750 '${REMOTE_ENV_DIR}'
"

rsync -az \
  -e "${RSYNC_RSH}" \
  ./.env.prod.example "${REMOTE_HOST}:${REMOTE_APP_DIR}/.env.prod.example"
rsync -az \
  -e "${RSYNC_RSH}" \
  ./deploy/ "${REMOTE_HOST}:${REMOTE_APP_DIR}/deploy/"
rsync -azc --delete --delete-excluded \
  --exclude ".git" \
  --exclude ".cache" \
  --exclude ".cert" \
  --exclude ".env" \
  --exclude ".env.*" \
  --exclude "node_modules" \
  --exclude ".next*" \
  --exclude ".paseo" \
  --exclude ".runtime" \
  --exclude ".tmp" \
  --exclude ".pnpm-store" \
  --exclude ".turbo" \
  --exclude "/workspaces/***" \
  -e "${RSYNC_RSH}" \
  "${LOCAL_WANGHAI_DIR}/" "${REMOTE_HOST}:${REMOTE_WANGHAI_DIR}/"

ssh "${REMOTE_HOST}" "set -euo pipefail
if [ \"\$(id -u)\" -eq 0 ]; then
  SUDO=''
else
  SUDO='sudo'
fi
APP_USER=\"\$(id -un)\"
APP_GROUP=\"\$(id -gn)\"

install_root_file() {
  local target=\"\$1\"
  local temp_file
  temp_file=\"\$(mktemp)\"
  cat > \"\${temp_file}\"
  if [ -n \"\${SUDO}\" ]; then
    \${SUDO} install -m 0644 \"\${temp_file}\" \"\${target}\"
  else
    install -m 0644 \"\${temp_file}\" \"\${target}\"
  fi
  rm -f \"\${temp_file}\"
}

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
  install_env_file \"\$temp_file\" \"\$file\"
  rm -f \"\${temp_file}\"
}

install_env_file() {
  local source_file=\"\$1\"
  local target_file=\"\$2\"
  if [ -n \"\$SUDO\" ]; then
    \$SUDO install -o root -g \"\$APP_GROUP\" -m 0640 \"\$source_file\" \"\$target_file\"
  else
    install -o root -g \"\$APP_GROUP\" -m 0640 \"\$source_file\" \"\$target_file\"
  fi
}

remove_env_line() {
  local key=\"\$1\"
  local file=\"\$2\"
  local temp_file
  temp_file=\"\$(mktemp)\"
  awk -v key=\"\${key}\" 'index(\$0, key \"=\") != 1 { print }' \"\${file}\" > \"\${temp_file}\"
  install_env_file \"\$temp_file\" \"\$file\"
  rm -f \"\${temp_file}\"
}

if [ ! -f '${REMOTE_ENV_FILE}' ]; then
  install_env_file '${REMOTE_APP_DIR}/.env.prod.example' '${REMOTE_ENV_FILE}'
else
  \$SUDO chown root:\"\$APP_GROUP\" '${REMOTE_ENV_FILE}'
  \$SUDO chmod 0640 '${REMOTE_ENV_FILE}'
fi

upsert_env_line 'POLARIS_DATA_ROOT' '${REMOTE_DATA_ROOT}' '${REMOTE_ENV_FILE}'
upsert_env_line 'POLARIS_NETFS_LOCAL_EXPORT_ROOT' '${REMOTE_NETFS_EXPORT_ROOT}' '${REMOTE_ENV_FILE}'
upsert_env_line 'POLARIS_RELEASE_PROFILE' '0.3.0-single-host' '${REMOTE_ENV_FILE}'
upsert_env_line 'POLARIS_DEPLOYMENT_MODE' 'single-host' '${REMOTE_ENV_FILE}'
upsert_env_line 'POLARIS_SERVER_REPLICAS' '1' '${REMOTE_ENV_FILE}'
upsert_env_line 'POLARIS_GATEWAY_REPLICAS' '1' '${REMOTE_ENV_FILE}'
upsert_env_line 'POLARIS_JOB_WORKER_CONCURRENCY' '1' '${REMOTE_ENV_FILE}'
upsert_env_line 'POLARIS_MAX_ACTIVE_VAULTS' '10' '${REMOTE_ENV_FILE}'
upsert_env_line 'POLARIS_ACTIVE_WORKSPACE_QUOTA_BYTES' '268435456' '${REMOTE_ENV_FILE}'
remove_env_line 'POLARIS_WANGHAI_DATA_ROOT' '${REMOTE_ENV_FILE}'

if [ -d '${REMOTE_APP_DIR}/config/state' ] && [ -z \"\$(find '${REMOTE_DATA_ROOT}/state' -mindepth 1 -maxdepth 1 2>/dev/null)\" ]; then
  rsync -a '${REMOTE_APP_DIR}/config/state/' '${REMOTE_DATA_ROOT}/state/'
fi

if [ ! -f '${REMOTE_ACTIVE_COLOR_FILE}' ]; then
  printf 'blue\n' | \${SUDO} tee '${REMOTE_ACTIVE_COLOR_FILE}' >/dev/null
fi

if [ ! -f '${REMOTE_UPSTREAM_FILE}' ]; then
  \${SUDO} cp '${REMOTE_APP_DIR}/deploy/nginx/polaris-upstream.blue.conf' '${REMOTE_UPSTREAM_FILE}'
fi

install_root_file /etc/nginx/sites-available/polaris-gateway.conf <<EOF
server {
  listen 80 default_server;
  listen [::]:80 default_server;
  server_name _;

  include ${REMOTE_UPSTREAM_FILE};

  location / {
    proxy_pass \\\$polaris_upstream;
    proxy_http_version 1.1;
    proxy_connect_timeout 300s;
    proxy_send_timeout 300s;
    proxy_read_timeout 300s;
    proxy_set_header Host \\\$host;
    proxy_set_header X-Real-IP \\\$remote_addr;
    proxy_set_header X-Forwarded-For \\\$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \\\$scheme;
  }
}
EOF

\${SUDO} rm -f /etc/nginx/sites-enabled/default
\${SUDO} ln -sfn /etc/nginx/sites-available/polaris-gateway.conf /etc/nginx/sites-enabled/polaris-gateway.conf

install_root_file /etc/systemd/system/polaris-server@.service <<EOF
[Unit]
Description=Polaris server (%i)
After=network-online.target docker.service
Wants=network-online.target docker.service

[Service]
Type=simple
User=\${APP_USER}
Group=\${APP_GROUP}
WorkingDirectory=${REMOTE_APP_DIR}
Environment=NODE_ENV=production
EnvironmentFile=${REMOTE_ENV_FILE}
EnvironmentFile=-${REMOTE_ENV_DIR}/polaris-server-%i.env
ExecStart=/bin/bash ${REMOTE_APP_DIR}/scripts/run-polaris-server-host.sh
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

install_root_file /etc/systemd/system/polaris-container-runtime-cleanup.service <<EOF
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

install_root_file /etc/systemd/system/polaris-container-runtime-cleanup.timer <<EOF
[Unit]
Description=Run Polaris remote container runtime cleanup daily

[Timer]
OnCalendar=*-*-* 04:40:00
Persistent=true
Unit=polaris-container-runtime-cleanup.service

[Install]
WantedBy=timers.target
EOF

\${SUDO} systemctl daemon-reload
\${SUDO} systemctl enable polaris-container-runtime-cleanup.timer
\${SUDO} systemctl restart polaris-container-runtime-cleanup.timer
set -a
# shellcheck disable=SC1090
source '${REMOTE_ENV_FILE}'
set +a
if ! [[ "\${POLARIS_WANGHAI_VAULT_IMAGE:-}" =~ @sha256:[a-f0-9]{64}\$ ]]; then
  echo 'remote provisioning: POLARIS_WANGHAI_VAULT_IMAGE must be a digest-pinned image reference' >&2
  exit 2
fi
if ! \${SUDO} docker image inspect "\${POLARIS_WANGHAI_VAULT_IMAGE}" >/dev/null 2>&1; then
  \${SUDO} docker pull "\${POLARIS_WANGHAI_VAULT_IMAGE}"
fi
\${SUDO} nginx -t
\${SUDO} systemctl reload nginx

nginx_dump=\"\$(\${SUDO} nginx -T 2>/dev/null || true)\"
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
    '   Required: Authing settings, gateway secret, and digest-pinned Wanghai image' \
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
  '   Required: Authing settings, gateway secret, and digest-pinned Wanghai image' \
  '2. Production data root: ${REMOTE_DATA_ROOT}' \
  '3. Run nginx -t && nginx -s reload on the remote host if you changed the upstream file' \
  '4. From your local machine, run: bash ./scripts/cd-remote.sh ${REMOTE_HOST}' \
"
