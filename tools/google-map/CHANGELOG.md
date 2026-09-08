# Changelog

## 0.4.1 — 2026-07-12

- Changed the default Google Maps interface language from German to English so
  a new workspace does not inherit a Switzerland-specific language choice.

## 0.4.0 — 2026-07-12

- Added `--workspace` and `--workspaces-root` support. A standard Maps run now
  writes to `acquisition/customer-data-collection/runs/<run-id>/` under the
  configured customer workspace.

## 0.3.0 — 2026-07-12

- Added automatic removal of Maps review, owner and image fields. Successful
  runs now emit a valid JSON array containing only public business-listing
  fields and delete the transient raw NDJSON file.
- Added `sanitize-results` for existing upstream NDJSON output.

## 0.2.1 — 2026-07-12

- Set the exact Playwright driver path supplied by the pinned upstream image.
  This avoids an obsolete `1.52.0` driver download attempted by the image's
  default `/opt` driver-path setting.

## 0.2.0 — 2026-07-12

- Defaulted runtime preparation to the published `v1.9.2` Docker image pinned
  to its immutable `sha256:54aa343…ae36654` digest.
- Kept explicit `--from-source` Docker builds available for backend debugging.
- Required an image digest for every explicit backend upgrade.

## 0.1.0 — 2026-07-12

- Added `clue-gogole-map-cli` as a versioned wrapper around the pinned
  `gosom/google-maps-scraper` backend.
- Pinned the backend to upstream tag `v1.9.2` and commit
  `27f774576996a45be662b6265dd4d45364d401ac`.
- Added Docker build/run commands, reproducible run metadata, a first Zürich
  design-gift query, and an explicit backend-upgrade command.
