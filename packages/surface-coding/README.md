# `@qingniao/surface-paseo`

Coding agent surface: **`/h/...` left/right IDE routes only**.

- Process: outer **paseo-web** (shared capability)
- Runtime peer: in-container **paseo daemon** `:6767`

Shell routes (`/settings/user`, `/hosts`) must not live here long-term.
See `PASEO_APP_SHELL_ROUTES_TO_REMOVE`.
