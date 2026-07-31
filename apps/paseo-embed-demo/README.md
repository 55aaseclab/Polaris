# Paseo Embed Demo

Start the dedicated local Paseo daemon. Its state stays in the workspace root:

```sh
paseo daemon start --home .paseo --listen 0.0.0.0:6768 --no-relay
```

Start the Paseo web app with the embed route enabled:

```sh
cd apps/paseo/source/packages/app
EXPO_PUBLIC_PASEO_EMBED_DEV=1 \
EXPO_PUBLIC_PASEO_EMBED_PARENT_ORIGIN=http://<host>:8090 \
npm run start:expo -- --port 8081
```

In another terminal:

```sh
pnpm paseo:embed-demo
```

Open `http://127.0.0.1:8090` locally. The portal listens on all interfaces,
loads Paseo from port `8081`, and connects to the dedicated daemon on port
`6768`.

The demo defaults to the repository workspace root as the daemon workspace.
Use the Portal's `PASEO HOST WORKSPACE` form to override it. The path is
resolved on the Paseo daemon host. On success, the demo stores the workspace
and agent IDs in its URL, then remounts the iframe with the new agent ID.
Reloading that URL reconnects to the same companion rather than an unrelated
active agent.

Set `PASEO_EMBED_DEFAULT_WORKSPACE` before starting the demo to change the
default. A query parameter overrides it and provisions automatically after the
first bridge connection:

```text
http://<host>:8090?workspacePath=/path/on/paseo-host
```

The demo imports the local `@paseo/embed` build; it does not implement iframe
or `postMessage` handling itself.

The default external request is `codex`, `gpt-5.4`, and `medium` thinking.
Query parameters `workspacePath`, `provider`, `model`, and `thinking` override
the form defaults.
