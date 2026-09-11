# Setup Camofox and a Polaristool browser session

Polaristool remote browsing uses
[camofox-browser](https://github.com/jo-inc/camofox-browser)
(`@askjo/camofox-browser`): a Camoufox (Firefox) REST server on port `9377`.
Do not clone that repo into Polaristool. Install it through `clue-browser`.

Camofox isolates cookies and localStorage per `userId` and writes them under
`~/.camofox/profiles/<hashed-userId>/storage_state.json`. Polaristool must use
a **stable** `userId`. If `BROWSER_CAMOFOX_USER_ID` is unset, `clue-browser`
falls back to `clue-<run_id>` and every capture starts a cold anonymous
profile.

X11 / Xvfb is in [SETUP-DISPLAY.md](./SETUP-DISPLAY.md).

## Install

```sh
./tools/browser/clue-browser setup
```

This installs Playwright Chromium plus `@askjo/camofox-browser` and fetches
the Camoufox binary (~300MB on first setup). `./tools/data-collection/install-dependencies.sh`
runs the same command.

Optional long-lived server (otherwise Polaristool starts one per capture):

```sh
export DISPLAY=:99
export BROWSER_CAMOFOX_URL=http://127.0.0.1:9377
export CAMOFOX_CRASH_REPORT_ENABLED=false
node tools/browser/node_modules/@askjo/camofox-browser/server.js
curl -fsS "$BROWSER_CAMOFOX_URL/health"
```

`clue-browser` maps `BROWSER_PROXY_*` into Camofox `PROXY_HOST` / `PROXY_PORT`
/ `PROXY_USERNAME` / `PROXY_PASSWORD` when input omits `browser.proxy`.

## Polaristool session

Put a stable session in `.env.dev` and keep it for every literature PDF run:

```sh
BROWSER_CAMOFOX_USER_ID=polaris-literature
# optional Netscape import after the session exists
# BROWSER_IMPORT_COOKIES_PATH=publisher.txt
# CAMOFOX_API_KEY=   # required for POST /sessions/:userId/cookies except loopback
```

`literature.pdf.capture` and `clue-browser` read `BROWSER_CAMOFOX_USER_ID`.
Collection PDF capture also writes that value as `browser.session_user_id`.
Camofox then reuses `~/.camofox/profiles/` across runs.

Layout:

```text
~/.camofox/
  cookies/                         Netscape bootstrap files
    cookies.txt                    auto-loaded once on an empty profile
    publisher.txt                  optional import via BROWSER_IMPORT_COOKIES_PATH
  profiles/<hashed-userId>/
    storage_state.json             cookies + localStorage after first login
```

## Seed the session

Pick one. After the first successful login, later captures reuse storage state.

### Cookie import

1. Export Netscape `cookies.txt` from a real browser (cookies.txt extension).
2. Copy it to `~/.camofox/cookies/` (override with `CAMOFOX_COOKIES_DIR`).
3. Set `BROWSER_IMPORT_COOKIES_PATH` to the file name or an absolute path.
4. Set `CAMOFOX_API_KEY` if Camofox is not on loopback. Cookie import is
   `POST /sessions/:userId/cookies` and returns 403 without the key.

```sh
mkdir -p ~/.camofox/cookies
cp ~/Downloads/publisher_cookies.txt ~/.camofox/cookies/publisher.txt
export BROWSER_CAMOFOX_USER_ID=polaris-literature
export BROWSER_IMPORT_COOKIES_PATH=publisher.txt
```

### Interactive desktop login

On a machine with a usable display:

```sh
export CAMOFOX_INTERACTIVE=desktop
export BROWSER_CAMOFOX_USER_ID=polaris-literature
# start Camofox, then open a publisher URL once and sign in
```

Camofox writes storage state for that `userId`. Unset `CAMOFOX_INTERACTIVE`
(or set it to `off`) for later headless capture.

### VNC login

Camofox can expose noVNC (`ENABLE_VNC=1`, `NOVNC_PORT=6080`, optional
`VNC_PASSWORD`). Log in once, then reuse the same `BROWSER_CAMOFOX_USER_ID`.

## Check

```sh
echo "DISPLAY=$DISPLAY userId=$BROWSER_CAMOFOX_USER_ID"
curl -fsS "${BROWSER_CAMOFOX_URL:-http://127.0.0.1:9377}/health"
ls ~/.camofox/profiles
```

Upstream reference: <https://github.com/jo-inc/camofox-browser>
