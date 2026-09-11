# clue-browser

`clue-browser` runs declared, auditable browser interactions.

**Default backend (remote URLs):** [Camofox](https://github.com/jo-inc/camofox-browser)
/ Camoufox — Firefox with C++ anti-detection (handles Cloudflare far better
than Chromium stealth plugins).

**Fallback / localhost:** Playwright Chromium (+ optional stealth plugins).

## Setup

Headed Camofox needs an X11 display and a persistent browser session. See
[SETUP-BROWSER.md](./SETUP-BROWSER.md) for Xvfb, `DISPLAY=:99`,
[camofox-browser](https://github.com/jo-inc/camofox-browser) installation, and
the stable Polaristool session (`BROWSER_CAMOFOX_USER_ID`).

## Setup (binaries)

```sh
./clue-browser setup
```

Installs Playwright Chromium and `@askjo/camofox-browser` (Camoufox binary is
downloaded on first setup/start).

For a container that already provides a compatible system Chromium, set
`CLUE_BROWSER_SKIP_PLAYWRIGHT_DOWNLOAD=1` during setup and
`BROWSER_EXECUTABLE_PATH` at runtime. Camofox setup remains unchanged.

## Backend selection

| Target | Default backend |
|--------|-----------------|
| `http://127.0.0.1…` / `localhost` | `playwright` |
| Remote HTTP(S) | `camofox` |

Override:

```json
"browser": {
  "backend": "camofox",
  "camofox_url": "http://127.0.0.1:9377"
}
```

```sh
# or
export BROWSER_BACKEND=camofox
export BROWSER_CAMOFOX_URL=http://127.0.0.1:9377
```

### Session reuse and cookie import (Camofox)

Camofox isolates cookies/storage per `userId` and can persist them under
`~/.camofox/profiles/`. For sites that need a real login (Google Scholar often
behaves better when signed in), use a **stable** session id and import cookies:

```json
"browser": {
  "backend": "camofox",
  "session_user_id": "clue-google-scholar",
  "import_cookies_path": "google-scholar.txt"
}
```

```sh
# Netscape export from a real browser (cookies.txt extension)
mkdir -p ~/.camofox/cookies
cp ~/Downloads/google_cookies.txt ~/.camofox/cookies/google-scholar.txt
# optional bootstrap name used on first empty profile:
# cp ... ~/.camofox/cookies/cookies.txt

export BROWSER_CAMOFOX_USER_ID=clue-google-scholar
export BROWSER_IMPORT_COOKIES_PATH=google-scholar.txt
# Cookie import API: CAMOFOX_API_KEY, or loopback without key in non-production
```

Relative `import_cookies_path` resolves under `CAMOFOX_COOKIES_DIR`
(default `~/.camofox/cookies`). Camofox also auto-loads `cookies.txt` once when
a profile has no persisted `storage-state` yet.

When `BROWSER_CAMOFOX_URL` is unset, `clue-browser` uses its local Camofox
startup path. If `browser.proxy` is omitted, a configured `BROWSER_PROXY_*`
environment is mapped to Camofox `PROXY_*`. No proxy is enabled unless
`BROWSER_PROXY_SERVER` is set.

## Proxy via environment

```sh
BROWSER_PROXY_SERVER=http://brd.superproxy.io:33335
BROWSER_PROXY_USERNAME=brd-customer-...
BROWSER_PROXY_PASSWORD=...
```

Used when `BROWSER_PROXY_SERVER` is set and `browser.proxy` is omitted. Input
`browser.proxy` wins. Set `"proxy": false` to disable the environment proxy.

## Input example

```json
{
  "schema_version": "clue.browser.input.v1",
  "run_id": "example-run",
  "start_url": "https://example.com/",
  "browser": {
    "backend": "camofox",
    "humanize": true,
    "timeout_ms": 120000,
    "wait_for_challenge": true,
    "challenge_timeout_ms": 90000
  },
  "actions": [
    {"type": "solve-challenge", "timeout_ms": 90000},
    {"type": "screenshot", "name": "landing", "full_page": true},
    {"type": "extract-text", "selector": "body", "name": "body", "max_chars": 2000}
  ]
}
```

Action types: `goto`, `click`, `fill`, `press`, `select`, `check`, `wait-for`,
`screenshot`, `extract-text`, `extract-attribute`, `extract-html`, `scroll`,
`solve-challenge`.

`extract-html` writes a full HTML artifact (kind `html`) and a truncated
preview in extractions. Omit `selector` to capture the full document; set
`max_chars` up to 2_000_000 for the preview size.

## Commands

```sh
./check-setup
./clue-browser version
./clue-browser validate-input --input input.json
./clue-browser validate-output --output output.json
./clue-browser run --input input.json --output output.json
```

`./check-setup` is what `ops tool-precheck` runs for this tool.

## Playwright path (optional)

Still available with `"backend": "playwright"` for local debugging and unit
tests. Includes stealth plugins, humanized input, and challenge click helpers.
See `CHANGELOG.md` 0.2.0 for details.

## Camofox notes

- Engine is Camoufox (Firefox), not Chromium.
- Prefer ISP/residential proxies for hard sites (Bright Data ISP works well).
- Inline PDFs may open in the Firefox viewer without a download event; snapshots
  still capture readable page text.
All Camofox deps live under `tools/browser/node_modules` only.

## Verification

```sh
pnpm --dir tools/browser test
```
