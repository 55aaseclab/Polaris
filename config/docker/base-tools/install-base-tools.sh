#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_MAJOR="${NODE_MAJOR:-22}"
TOOL_PREFIX="${TOOL_PREFIX:-/root/.local/polaris}"
PASEO_TOOL_BUNDLE_DIR="${PASEO_TOOL_BUNDLE_DIR:-/tmp/paseo-tool-bundle}"

read_list() {
  local file_path="$1"
  grep -Ev '^\s*(#|$)' "$file_path"
}

readarray -t APT_PACKAGES < <(read_list "$ROOT_DIR/apt-packages.txt")
readarray -t PYTHON_PACKAGES < <(read_list "$ROOT_DIR/python-packages.txt")
readarray -t NODE_PACKAGES < <(read_list "$ROOT_DIR/node-packages.txt")
readarray -t NON_PASEO_NODE_PACKAGES < <(printf '%s\n' "${NODE_PACKAGES[@]}" | grep -Fvx '@getpaseo/cli@latest' || true)

apt-get update
apt-get install -y --no-install-recommends "${APT_PACKAGES[@]}"

mkdir -p /etc/apt/keyrings /etc/apt/sources.list.d
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
  | gpg --dearmor --batch --yes --no-tty -o /etc/apt/keyrings/nodesource.gpg
printf '%s\n' \
  "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
  > /etc/apt/sources.list.d/nodesource.list

apt-get update
apt-get install -y --no-install-recommends nodejs

python3 -m pip install --no-cache-dir --break-system-packages \
  "${PYTHON_PACKAGES[@]}"

RUSTUP_PROFILE="${RUSTUP_PROFILE:-minimal}"
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
  | sh -s -- -y --profile "${RUSTUP_PROFILE}"
export PATH="/root/.cargo/bin:${PATH}"
rustup component add rustfmt clippy

mkdir -p "$TOOL_PREFIX" /root/.npm
if [ -x "$PASEO_TOOL_BUNDLE_DIR/bin/paseo" ]; then
  cp -a "$PASEO_TOOL_BUNDLE_DIR"/. "$TOOL_PREFIX"/
fi
npm install -g --prefix "$TOOL_PREFIX" "${NON_PASEO_NODE_PACKAGES[@]}"
if [ ! -x "$TOOL_PREFIX/bin/paseo" ]; then
  npm install -g --prefix "$TOOL_PREFIX" @getpaseo/cli@latest
fi
npm cache clean --force >/dev/null 2>&1

if command -v fdfind >/dev/null 2>&1; then
  ln -sf "$(command -v fdfind)" /usr/local/bin/fd
fi

ln -sf "$TOOL_PREFIX/bin/paseo" /usr/local/bin/paseo
ln -sf "$TOOL_PREFIX/bin/pnpm" /usr/local/bin/pnpm

cat >/usr/local/bin/codex <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
export CODEX_HOME=/root/.codex
export NPM_CONFIG_PREFIX=/root/.local/polaris
export npm_config_cache=/root/.npm
mkdir -p /root/.codex
exec /root/.local/polaris/bin/codex "$@"
EOF
chmod 755 /usr/local/bin/codex

cat >/usr/local/bin/claude <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
export NPM_CONFIG_PREFIX=/root/.local/polaris
export npm_config_cache=/root/.npm
exec /root/.local/polaris/bin/claude "$@"
EOF
chmod 755 /usr/local/bin/claude

rm -rf /var/lib/apt/lists/*
