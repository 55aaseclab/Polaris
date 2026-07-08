#!/usr/bin/env bash

set -euo pipefail

target_repo="${1:-../jianxiaoyitech-skills}"
commit_message="${2:-Sync skills from geek-env}"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "error: must run inside a git repository" >&2
  exit 1
fi

if [ ! -d "$target_repo/.git" ]; then
  echo "error: target repo '$target_repo' is not a git repository" >&2
  exit 1
fi

mkdir -p "$target_repo/skills"
find "$target_repo/skills" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
cp -R skills/. "$target_repo/skills/"
find "$target_repo/skills" -type d -name '__pycache__' -prune -exec rm -rf {} +
find "$target_repo/skills" -type f \( -name '*.pyc' -o -name '*.pyo' \) -delete

git -C "$target_repo" add -A

if git -C "$target_repo" diff --cached --quiet; then
  echo "no skills changes to sync"
  exit 0
fi

git -C "$target_repo" commit -m "$commit_message"

echo "synced skills/ to $target_repo/skills"
