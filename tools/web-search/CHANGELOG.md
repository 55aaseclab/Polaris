# Changelog

## 0.2.1 — 2026-07-12

- Switched source-result schema names to the generic customer-data collection
  contract so they can be consumed by any workspace.

## 0.2.0 — 2026-07-12

- Added workspace-aware batch execution with `--workspace`,
  `--workspaces-root` and `--run-id`.
- Standard runs now read `inputs/input.json` and write their auditable output
  under `acquisition/customer-data-collection/runs/`.

## 0.1.1 — 2026-07-12

- Write one compact JSON object per line to `commands.jsonl`.
- Added `normalize-command-log` to convert an existing multi-document JSON
  stream into valid JSON Lines in place.

## 0.1.0 — 2026-07-12

- Added `clue-web-search-cli`, a versioned batch wrapper around a pinned local
  SearXNG backend.
- Pinned SearXNG source commit `c19d86faa393bdd696a5708e3c294f956d750683`
  and its published Linux amd64 Docker digest.
- Added source-task filtering, local-only server orchestration, per-task JSON
  results, command logging, and transient-response removal.
