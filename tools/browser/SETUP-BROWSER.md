# Browser setup for PDF capture

Polaris literature PDF capture uses `clue-browser`. Remote HTTP(S) targets
use Camofox by default; localhost targets use the Playwright fallback.

This guide covers the display, browser runtime, proxy configuration, and
Camofox session. Camofox is provided by
[camofox-browser](https://github.com/jo-inc/camofox-browser)
(`@askjo/camofox-browser`).

## 1. Prepare the display

Install Xvfb when the host has no desktop display. Polaristool does not start
Xvfb itself.

```sh
sudo apt-get install -y --no-install-recommends xvfb
export DISPLAY=:99
if ! pgrep -af "Xvfb ${DISPLAY}" >/dev/null 2>&1; then
  Xvfb "${DISPLAY}" -screen 0 1920x1080x24 -nolisten tcp \
    >/tmp/polaris-xvfb.log 2>&1 &
fi
xdpyinfo >/dev/null
```

Put `DISPLAY=:99` in `.env.dev` when this display should be used after a
restart. If the host already has a usable desktop display, keep its existing
`DISPLAY` value.

## 2. Install the browser runtime

Run once from the Polaris repository:

```sh
./tools/browser/clue-browser setup
```

This installs Playwright Chromium and `@askjo/camofox-browser`, and fetches
the Camoufox binary. The data-collection dependency installer runs the same
setup.

## 3. Configure the proxy

Set the proxy environment before starting Camofox or running PDF capture:

```sh
export BROWSER_PROXY_SERVER=http://proxy.example:33335
export BROWSER_PROXY_USERNAME=proxy-user
export BROWSER_PROXY_PASSWORD=proxy-password
export BROWSER_PROXY_BYPASS=localhost,127.0.0.1
```

`BROWSER_PROXY_SERVER` enables the environment proxy. Username and password
are passed through for proxy authentication. If the proxy does not require
authentication, omit those two variables. `BROWSER_PROXY_BYPASS` is optional.

When `browser.proxy` is omitted, the configured `BROWSER_PROXY_*` values are
mapped to Camofox `PROXY_HOST`, `PROXY_PORT`, `PROXY_USERNAME`, and
`PROXY_PASSWORD` when Camofox starts. An explicit browser input takes
precedence:

```json
{"browser": {"proxy": false}}
```

The explicit `false` disables the environment proxy for that run. An explicit
`browser.proxy` object supplies the proxy for that run. If no proxy variables
are set, no proxy is passed to Camofox.

## 4. Start or reuse Camofox

`BROWSER_CAMOFOX_URL` is optional. Set it when a long-lived Camofox server is
already running or when you want to run one yourself:

```sh
export DISPLAY=:99
export BROWSER_CAMOFOX_URL=http://127.0.0.1:9377
export CAMOFOX_CRASH_REPORT_ENABLED=false
node tools/browser/node_modules/@askjo/camofox-browser/server.js
curl -fsS "$BROWSER_CAMOFOX_URL/health"
```

When `BROWSER_CAMOFOX_URL` is unset, `clue-browser` uses its local Camofox
startup path. A configured URL must be reachable and return a healthy
`/health` response; it is not silently replaced by another remote server.

## 5. Configure the Camofox session

Camofox stores cookies and localStorage per `userId`. Use a stable ID for all
literature PDF runs:

```sh
export BROWSER_CAMOFOX_USER_ID=polaris-literature
```

The profile is stored at
`~/.camofox/profiles/<hashed-userId>/storage_state.json`. A stable ID makes a
session reusable but does not log in to a publisher.

### Cookie import

First export the cookies from the already authenticated publisher browser
session in Netscape `cookies.txt` format. A browser cookie-export extension can
create this file. The export is an input supplied by you; Polaris does not
download or create it.

Then use the actual path and filename of that export:

```sh
mkdir -p ~/.camofox/cookies
cp /path/to/your/exported-cookies.txt ~/.camofox/cookies/publisher.txt
export BROWSER_IMPORT_COOKIES_PATH=publisher.txt
```

`/path/to/your/exported-cookies.txt` is a placeholder and must be replaced by
the file you exported. The destination filename `publisher.txt` is arbitrary;
it is only the local name used by `BROWSER_IMPORT_COOKIES_PATH`.

Relative paths use `CAMOFOX_COOKIES_DIR` (default `~/.camofox/cookies`). An
absolute path is also accepted. Set `CAMOFOX_API_KEY` when Camofox is not on
loopback because cookie import calls `POST /sessions/:userId/cookies`.

```sh
export CAMOFOX_API_KEY=your-camofox-api-key
```

### Interactive login

With a usable desktop display, open the publisher URL in Camofox and sign in:

```sh
export CAMOFOX_INTERACTIVE=desktop
export BROWSER_CAMOFOX_USER_ID=polaris-literature
```

After login, unset `CAMOFOX_INTERACTIVE` or set it to `off` for normal capture.
Alternatively, start Camofox with `ENABLE_VNC=1` and `NOVNC_PORT=6080` for a
VNC login; set `VNC_PASSWORD` when required.

## 6. Verify the setup

```sh
./tools/browser/check-setup
xdpyinfo >/dev/null
curl -fsS "${BROWSER_CAMOFOX_URL:-http://127.0.0.1:9377}/health"
ls ~/.camofox/profiles
```

These checks verify the display, server health, and profile directory. They do
not verify that a publisher account is logged in.

Upstream reference:
<https://github.com/jo-inc/camofox-browser>
