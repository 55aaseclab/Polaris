# Set up DISPLAY and Camofox

Polaristool's headed browser capture uses an X11 display and Camofox. This
guide covers both the host display and the persistent Camofox browser session.

Camofox is provided by
[camofox-browser](https://github.com/jo-inc/camofox-browser)
(`@askjo/camofox-browser`), a Camoufox (Firefox) REST server on port `9377`.
Do not clone that repository into Polaris. Install it through `clue-browser`.

## Host display

Polaristool does not start Xvfb itself. Install it and start a display for
headed Camofox capture:

```sh
sudo apt-get install -y --no-install-recommends xvfb
export DISPLAY=:99
if ! pgrep -af "Xvfb ${DISPLAY}" >/dev/null 2>&1; then
  Xvfb "${DISPLAY}" -screen 0 1920x1080x24 -nolisten tcp >/tmp/polaris-xvfb.log 2>&1 &
fi
xdpyinfo >/dev/null
```

Put `DISPLAY=:99` in `.env.dev` so Polaristool uses the same display after a
restart.

## Install Camofox

```sh
./tools/browser/clue-browser setup
```

This installs Playwright Chromium, `@askjo/camofox-browser`, and fetches the
Camoufox binary (about 300 MB on first setup). The data-collection dependency
installer runs the same browser setup.

You can run a long-lived local server instead of starting one per capture:

```sh
export DISPLAY=:99
export BROWSER_CAMOFOX_URL=http://127.0.0.1:9377
export CAMOFOX_CRASH_REPORT_ENABLED=false
node tools/browser/node_modules/@askjo/camofox-browser/server.js
curl -fsS "$BROWSER_CAMOFOX_URL/health"
```

If `BROWSER_CAMOFOX_URL` is unset or unhealthy, `clue-browser` starts a local
Camofox for the run. `BROWSER_PROXY_*` is mapped to Camofox
`PROXY_HOST`/`PROXY_PORT`/`PROXY_USERNAME`/`PROXY_PASSWORD` when input does not
provide `browser.proxy`.

## Persistent session

Camofox isolates cookies and localStorage per `userId` and stores them under
`~/.camofox/profiles/<hashed-userId>/storage_state.json`. Keep a stable user
ID for every literature PDF run:

```sh
BROWSER_CAMOFOX_USER_ID=polaris-literature
# Optional Netscape import after the session exists:
# BROWSER_IMPORT_COOKIES_PATH=publisher.txt
# Required for cookie POSTs when Camofox is not on loopback:
# CAMOFOX_API_KEY=...
```

`literature.pdf.capture` and `clue-browser` read
`BROWSER_CAMOFOX_USER_ID`. Collection PDF capture also records it as
`browser.session_user_id`. Camofox then reuses the profile across runs.

The session layout is:

```text
~/.camofox/
  cookies/                         Netscape bootstrap files
    cookies.txt                    auto-loaded once on an empty profile
    publisher.txt                  optional import via BROWSER_IMPORT_COOKIES_PATH
  profiles/<hashed-userId>/
    storage_state.json             cookies + localStorage after first login
```

## Seed the session

Choose cookie import or one interactive login. After the first successful
login, later captures reuse the stored state.

### Cookie import

1. Export Netscape `cookies.txt` from a real browser.
2. Copy it to `~/.camofox/cookies/` (override with `CAMOFOX_COOKIES_DIR`).
3. Set `BROWSER_IMPORT_COOKIES_PATH` to the file name or an absolute path.
4. Set `CAMOFOX_API_KEY` when Camofox is not on loopback.

```sh
mkdir -p ~/.camofox/cookies
cp ~/Downloads/publisher_cookies.txt ~/.camofox/cookies/publisher.txt
export BROWSER_CAMOFOX_USER_ID=polaris-literature
export BROWSER_IMPORT_COOKIES_PATH=publisher.txt
```

Cookie import calls `POST /sessions/:userId/cookies` and returns 403 without
the API key when the server is not local.

### Interactive desktop login

On a machine with a usable display, start Camofox and log in once:

```sh
export CAMOFOX_INTERACTIVE=desktop
export BROWSER_CAMOFOX_USER_ID=polaris-literature
# Open a publisher URL in the session and sign in.
```

Camofox writes storage state for that user. Unset `CAMOFOX_INTERACTIVE` (or set
it to `off`) for later headless capture.

### VNC login

Camofox can expose noVNC with `ENABLE_VNC=1` and `NOVNC_PORT=6080`; set
`VNC_PASSWORD` when needed. Log in once and reuse the same
`BROWSER_CAMOFOX_USER_ID`.

## Proxy

When publisher sites require an ISP or residential proxy:

```sh
BROWSER_PROXY_SERVER=http://brd.superproxy.io:33335
BROWSER_PROXY_USERNAME=brd-customer-...
BROWSER_PROXY_PASSWORD=...
# Optional comma-separated bypass list:
BROWSER_PROXY_BYPASS=localhost,127.0.0.1
```

## Check

```sh
echo "DISPLAY=$DISPLAY userId=$BROWSER_CAMOFOX_USER_ID"
xdpyinfo >/dev/null
curl -fsS "${BROWSER_CAMOFOX_URL:-http://127.0.0.1:9377}/health"
ls ~/.camofox/profiles
```

Upstream reference:
<https://github.com/jo-inc/camofox-browser>
