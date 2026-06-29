# Docs Changelog

## latest vs 0.2.2

### Added

- Versioned docs layout under `docs/<version>`.
- `docs/latest/VERSION.md`.
- `docs/latest/CHANGELOG.md`.
- Detailed Polaris architecture and lifecycle explanation.
- Detailed local-stack, status, provisioning, and debugging guidance.
- Docs viewer application requirement in `apps/docs`.
- Explicit documentation for the recent Polaris performance work:
  shared prebuilt images, cached status reads, runtime status reporting,
  portal provisioning jobs, and local UI updates.

### Changed

- Root docs index now treats docs as releaseable artifacts.
- Polaris docs now describe the portal, executor, runtime status observer, and
  status cache model together.
- Runtime status reporting and runtime memory observation are now described as
  separate runtime layers.
- Remote deploy docs now describe host/data/env ownership more explicitly.
- Polaris docs now describe the concrete behavior after the latest performance
  optimization pass instead of only the intended direction.

### Removed

- Implicit assumption that a single `docs/` tree is the only source of truth.

### Notes

- `latest` is intentionally more detailed than `0.2.2`.
- `0.2.2` remains a frozen snapshot for comparison.
