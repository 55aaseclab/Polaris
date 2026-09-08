# Changelog

## 0.3.2 - 2026-07-22

- Added `browser.session_user_id` / `BROWSER_CAMOFOX_USER_ID` so Camofox
  reuses a stable user profile (`~/.camofox/profiles`) instead of a fresh
  `clue-<run_id>` session every run.
- Added `browser.import_cookies_path` / `BROWSER_IMPORT_COOKIES_PATH` to inject
  Netscape `cookies.txt` after tab create via Camofox
  `POST /sessions/:userId/cookies` (authenticated browsing / Google login).

## 0.3.1 - 2026-07-22

- Added `extract-html` action: capture `outerHTML` (or full page when selector
  is omitted), write a `.html` artifact, and return a truncated preview in
  extractions. Supports Scholar-sized pages (up to 2 MiB preview; full HTML
  always on disk).

## 0.3.0 - 2026-07-22

- Default backend for remote URLs is **Camofox** (`@askjo/camofox-browser` /
  Camoufox), which bypasses Cloudflare better than Chromium stealth plugins.
- Added `browser.backend`: `camofox` | `playwright` (auto: camofox for remote,
  playwright for localhost).
- Added `browser.camofox_url` / `BROWSER_CAMOFOX_URL`; auto-starts a local
  Camofox server when none is healthy.
- Maps `BROWSER_PROXY_*` into Camofox `PROXY_*` on server start.
- Playwright stealth path remains available for local tests and fallback.

## 0.2.0 - 2026-07-21

- Enabled stealth by default via `playwright-extra` and
  `puppeteer-extra-plugin-stealth`, plus launch args and init-script patches.
- Enabled humanized interaction by default: random think-time, cubic-bezier
  mouse moves, per-character typing, and light scrolling.
- Added `browser.stealth`, `browser.humanize`, viewport / locale / timezone /
  user-agent, channel, proxy, persistent `user_data_dir`, and random pacing
  bounds.
- Added a declared `scroll` action.
- Removed anti-scraper policy blocks (HTTP 401/403/429 hard-stop, password
  field ban, download ban) and related documentation constraints.
- Accept navigation downloads and binary response bodies (PDF/attachments) as
  hash-recorded artifacts.
- Click Cloudflare Turnstile/checkbox/iframe widgets while waiting
  (`challenge_click`, default true) and via `solve-challenge` actions.
- Snapshot challenges to `challenge-NN.png` + `.layout.json`; built-in
  parser (`scripts/challenge-vision-helper.mjs`, imported by the runner)
  returns click `x,y` from layout (and optional vision API keys).
- Record active stealth, humanize, proxy, and channel settings in
  `automation_policy`.

## 0.1.0 - 2026-07-21

- Added a generic, declared-action Playwright Chromium browser tool.
- Added bounded navigation, interaction, text extraction, and screenshot
  artifacts.
