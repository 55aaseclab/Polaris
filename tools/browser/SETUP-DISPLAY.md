# Setup DISPLAY and Camofox

Headed Camofox (`clue-browser` / literature PDF capture) needs an X11 display.
Polaristool does not start Xvfb itself. The archived Wanghai container did:
`scripts/container-entrypoint.sh` exported `DISPLAY=${DISPLAY:-:99}` and started
`Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp` when Xvfb was installed.

## Host

```sh
sudo apt-get install -y --no-install-recommends xvfb
export DISPLAY=:99
if ! pgrep -af "Xvfb ${DISPLAY}" >/dev/null 2>&1; then
  Xvfb "${DISPLAY}" -screen 0 1920x1080x24 -nolisten tcp >/tmp/polaris-xvfb.log 2>&1 &
fi
xdpyinfo >/dev/null
```

Put `DISPLAY=:99` in Polaristool `.env.dev`. Optional Bright Data / ISP proxy
used when capture input omits `browser.proxy`:

```sh
BROWSER_PROXY_SERVER=http://brd.superproxy.io:33335
BROWSER_PROXY_USERNAME=...
BROWSER_PROXY_PASSWORD=...
```

## Camofox

```sh
./tools/browser/clue-browser setup
# optional long-lived server
export BROWSER_CAMOFOX_URL=http://127.0.0.1:9377
```

`clue-browser` starts a local Camofox when `BROWSER_CAMOFOX_URL` is unset or
unhealthy, and maps `BROWSER_PROXY_*` into Camofox `PROXY_*`.
`./tools/data-collection/install-dependencies.sh` also runs this setup.

A stable Camofox `userId` is required so cookies survive across captures.
See [SETUP-CAMOFOX.md](./SETUP-CAMOFOX.md).

## Check

```sh
echo "DISPLAY=$DISPLAY"
xdpyinfo >/dev/null && echo "display: usable"
curl -fsS "${BROWSER_CAMOFOX_URL:-http://127.0.0.1:9377}/health" || true
```
