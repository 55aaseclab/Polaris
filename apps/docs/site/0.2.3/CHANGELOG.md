# Docs Changelog

## 0.2.3 vs 0.2.2

### Added

- Versioned docs layout under `apps/docs/site/<version>`.
- A docs viewer app in `apps/docs` with version browsing and inline diff pages.
- Release metadata files for `latest` and `0.2.3`.
- Expanded Polaris architecture, lifecycle, status, and debugging guidance.

### Changed

- Docs are now treated as versioned release artifacts instead of one mutable
  tree.
- Polaris docs now describe portal behavior, executor behavior, runtime status
  reporting, and memory observation as one coherent control-plane model.
- Remote deploy and local stack docs now describe data ownership and runtime
  boundaries more explicitly.

### Notes

- `0.2.3` is the current frozen release snapshot.
- `latest` starts from this baseline.
