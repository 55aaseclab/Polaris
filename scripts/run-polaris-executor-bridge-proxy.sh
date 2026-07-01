#!/usr/bin/env bash
set -euo pipefail

if ! command -v socat >/dev/null 2>&1; then
  echo "Missing socat" >&2
  exit 1
fi

bridge_ip="$(ip -4 addr show docker0 2>/dev/null | awk '/inet / {print $2}' | cut -d/ -f1 | head -n 1)"
if [ -z "${bridge_ip}" ]; then
  echo "Unable to resolve docker0 IPv4 address" >&2
  exit 1
fi

exec socat TCP-LISTEN:8788,bind="${bridge_ip}",reuseaddr,fork TCP:127.0.0.1:8788
