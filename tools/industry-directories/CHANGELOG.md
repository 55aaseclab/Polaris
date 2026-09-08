# Changelog

## 0.2.1 — 2026-07-12

- Switched listing-result schema names to the generic customer-data collection
  contract.
- Removed the Switzerland-specific directory default. Each customer input now
  declares `industry_directories.directory_domains`, unless the CLI receives an
  explicit `--directory-domains` override.

## 0.2.0 — 2026-07-12

- Added workspace-aware `batch` and `finalize` commands with `--workspace`,
  `--workspaces-root` and `--run-id`.
- Updated the locked web-search dependency to its workspace-aware 0.2.0
  interface and lock digest.

## 0.1.1 — 2026-07-12

- Replaced search-engine-dependent `site:` query syntax with a directory-domain
  keyword and retained strict result-host filtering.
- Added `finalize` so wrapper outputs can be safely rebuilt from a completed
  child search run without submitting searches again.

## 0.1.0 — 2026-07-12

- Added `clue-industry-directory-cli`, a versioned directory-discovery wrapper.
- Locked the dependent `clue-web-search-cli` configuration and its SearXNG
  backend revision/image digest.
- Added directory-targeted discovery for configurable business-directory
  domains.
- Kept a structured listing-candidate output separate from verified customer
  leads and retained the underlying search trace for every candidate.
