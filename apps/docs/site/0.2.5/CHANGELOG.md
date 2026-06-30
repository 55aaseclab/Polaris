# Docs Changelog

## 0.2.5 vs 0.2.4

### Added

- Workspace lifecycle locking guidance for Polaris control-plane writes.
- TODO coverage for replacing `withFakePath`-heavy command stubs with more real
  backend smoke and integration coverage.

### Changed

- Clerk integration notes now describe both user-scoped mutation locking and
  workspace-scoped lifecycle locking.
- Polaris ownership and delete semantics now reflect the hardened queue,
  rollback, and archive/delete control flow.

### Notes

- `0.2.5` is the current frozen release snapshot.
- `latest` starts from this baseline.
