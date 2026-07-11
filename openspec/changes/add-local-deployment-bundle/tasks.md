## 1. Scope and docs

- [x] 1.1 Add stage-one local deployment docs under `apps/docs` that separate
  local deployment from local development
- [x] 1.2 Document the stage-one support matrix for Linux, Windows, macOS, and
  Docker-only runtime scope
- [x] 1.3 Document stage-one non-goals, including no `pod`,
  `kubevirt-vm`, host nginx, blue/green, or resident local control service

## 2. Shared local deployment control model

- [x] 2.1 Define the shared lifecycle actions for local deployment:
  install, start, stop, restart, status, open, logs, doctor, upgrade,
  and uninstall
- [x] 2.2 Introduce a single local deployment control surface that both GUI and
  CLI entry points can call
- [x] 2.3 Add platform-aware resolution for the persistent local data root on
  Linux, macOS, and Windows

## 3. Fixed deployment runtime

- [x] 3.1 Create a Docker-only local deployment bundle that uses fixed
  artifacts or fixed images instead of development servers
- [x] 3.2 Remove local deployment dependence on `vite` dev server,
  `tsx watch`, and source watch processes
- [x] 3.3 Ensure the local deployment runtime does not depend on host network,
  `docker0`, or other Linux-only host assumptions

## 4. Entry points and diagnostics

- [x] 4.1 Add a CLI entry point for the shared local deployment lifecycle
  actions
- [x] 4.2 Add a thin GUI entry point that drives the same local deployment
  lifecycle actions
- [x] 4.3 Add user-facing prerequisite and diagnostic handling for missing
  Docker, blocked ports, and local storage failures

## 5. Verification

- [x] 5.1 Add tests that verify local deployment guidance does not default to
  development-only entry points
- [x] 5.2 Add tests for the shared local deployment control model and
  platform-aware data-root resolution
- [x] 5.3 Validate that the stage-one local deployment bundle can boot the
  portal without development servers

## 6. Packaging and release artifacts

- [x] 6.1 Add a release bundle layout that treats the local deployment control
  layer as an internal runtime, not as the user-facing install surface
- [x] 6.2 Add packaging build scripts that emit Debian `.deb` artifacts with
  installed GUI and CLI entry points
- [x] 6.3 Add packaging build scripts that emit Windows `.exe` artifacts for
  the GUI and CLI entry points
- [x] 6.4 Add release metadata or workflow wiring so packaged launchers can
  resolve fixed runtime bundle assets after installation
- [x] 6.5 Add verification for the packaging output shape and installed entry
  points
