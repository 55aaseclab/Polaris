#!/usr/bin/env bash

set -euo pipefail

target_dir="${1:-../jianxiaoyitech-skills}"

mkdir -p "$target_dir"
find "$target_dir" -mindepth 1 -maxdepth 1 \
  ! -name '.git' \
  ! -name '.' \
  ! -name '..' \
  -exec rm -rf {} +
mkdir -p "$target_dir/skills"
find "$target_dir/skills" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
cp -R skills/. "$target_dir/skills/"

find "$target_dir/skills" -type d -name '__pycache__' -prune -exec rm -rf {} +
find "$target_dir/skills" -type f \( -name '*.pyc' -o -name '*.pyo' \) -delete

echo "copied skills/ to $target_dir/skills"
