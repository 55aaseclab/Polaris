# Paseo surface patches for Polaris

`apps/paseo` holds the reproducible Polaris patch set that is applied on top of
the upstream Paseo source tree.

Current architecture:

- `@qingniao/polaris-shell` owns the outer browser shell and routes such as
  `/`, `/welcome`, `/auth/callback`, `/hosts`, and `/settings/user`.
- `@qingniao/surface-paseo` owns the coding surface under `/h/...`.
- `apps/polaris` serves the shell assets and proxies only `/h/...` plus Expo
  assets to the Paseo web build.

This directory therefore exists to keep the Paseo coding surface reproducible,
not to host a second Polaris control shell inside the Expo app.

## Layout

- `source/`: checked-in upstream Paseo source used as the patch application
  base.
- `patches/`: Polaris patches applied in Docker builds.
- `Dockerfile.artifact`: builds the static Paseo web artifact with the patch
  stack applied.
- `Dockerfile.tool-bundle`: builds the patched Paseo server and CLI tool
  bundle.

## Patch workflow

1. Make the required change against the working Paseo source copy.
2. Regenerate the patch files in `patches/`.
3. Verify the patch list still applies in both Dockerfiles.

The source of truth for route ownership lives in:

- `packages/polaris-shell`
- `packages/surface-coding`
- `packages/surface-wanghai`
- `apps/docs/site/polaris/surfaces-and-routes.md`
