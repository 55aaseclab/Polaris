#!/usr/bin/env node
/** Playwright browser automation with stealth + humanized interaction. */

import { createHash, randomInt } from "node:crypto";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";

import {
  pointsFromLayout as helperPointsFromLayout,
  resolveChallengeClickPoints,
} from "./scripts/challenge-vision-helper.mjs";

export const TOOL_NAME = "clue-browser";
export const INPUT_SCHEMA = "clue.browser.input.v1";
export const OUTPUT_SCHEMA = "clue.browser.output.v1";

const ACTION_TYPES = new Set([
  "goto",
  "click",
  "fill",
  "press",
  "select",
  "check",
  "wait-for",
  "screenshot",
  "extract-text",
  "extract-attribute",
  "extract-html",
  "scroll",
  "solve-challenge",
]);
const WAIT_UNTIL = new Set(["commit", "domcontentloaded", "load", "networkidle"]);
const CHALLENGE_PAGE_SELECTORS = [
  "input[type='checkbox']",
  ".cf-turnstile",
  ".cf-turnstile iframe",
  "#challenge-stage",
  "#challenge-form",
  "#challenge-running",
  "label.ctp-checkbox-label",
  ".ctp-checkbox-label",
  "[name='cf-turnstile-response']",
  "iframe[src*='challenges.cloudflare.com']",
  "iframe[src*='turnstile']",
  "iframe[title*='Widget']",
  "iframe[title*='challenge']",
  "text=Verify you are human",
  "text=Verify you are a human",
  "text=确认您是真人",
];
const CHALLENGE_FRAME_SELECTORS = [
  "input[type='checkbox']",
  "label",
  "label.ctp-checkbox-label",
  ".ctp-checkbox-label",
  "#challenge-stage",
  "#success",
  "body",
];
const MAX_ACTIONS = 100;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_EXTRACT_CHARS = 10_000;
const MAX_EXTRACT_CHARS = 50_000;
const DEFAULT_HTML_EXTRACT_CHARS = 500_000;
const MAX_HTML_EXTRACT_CHARS = 2_000_000;

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const DEFAULT_VIEWPORT = { width: 1920, height: 1080 };
const DEFAULT_LOCALE = "en-US";
const DEFAULT_TIMEZONE = "America/New_York";
const DEFAULT_HUMAN_MIN_MS = 400;
const DEFAULT_HUMAN_MAX_MS = 1_800;
const STEALTH_LAUNCH_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--disable-infobars",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
];

const STEALTH_INIT_SCRIPT = `
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
window.chrome = window.chrome || { runtime: {} };
Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
Object.defineProperty(navigator, 'plugins', {
  get: () => [1, 2, 3, 4, 5],
});
const originalQuery = window.navigator.permissions && window.navigator.permissions.query;
if (originalQuery) {
  window.navigator.permissions.query = (parameters) => (
    parameters && parameters.name === 'notifications'
      ? Promise.resolve({ state: Notification.permission })
      : originalQuery(parameters)
  );
}
`;

export class CliError extends Error {}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new CliError(`${label} must be a non-empty string`);
  }
  return value;
}

function requireHttpUrl(value, label) {
  const url = requireString(value, label);
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new CliError(`${label} must be an HTTP(S) URL`);
  }
  if (!parsed.hostname || !["http:", "https:"].includes(parsed.protocol)) {
    throw new CliError(`${label} must be an HTTP(S) URL`);
  }
  return url;
}

function requireSelector(action, label) {
  const selector = requireString(action.selector, `${label}.selector`);
  if (selector.length > 500) {
    throw new CliError(`${label}.selector must not exceed 500 characters`);
  }
  return selector;
}

function optionalName(value, label) {
  if (value === undefined) {
    return undefined;
  }
  const name = requireString(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
    throw new CliError(`${label} may contain only letters, numbers, dot, underscore, and hyphen`);
  }
  return name;
}

function timeout(value, label, fallback = DEFAULT_TIMEOUT_MS) {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) {
    throw new CliError(`${label} must be an integer from 1 to ${MAX_TIMEOUT_MS}`);
  }
  return value;
}

function maxChars(value, label) {
  if (value === undefined) {
    return DEFAULT_EXTRACT_CHARS;
  }
  if (!Number.isInteger(value) || value < 1 || value > MAX_EXTRACT_CHARS) {
    throw new CliError(`${label} must be an integer from 1 to ${MAX_EXTRACT_CHARS}`);
  }
  return value;
}

function maxHtmlChars(value, label) {
  if (value === undefined) {
    return DEFAULT_HTML_EXTRACT_CHARS;
  }
  if (!Number.isInteger(value) || value < 1 || value > MAX_HTML_EXTRACT_CHARS) {
    throw new CliError(`${label} must be an integer from 1 to ${MAX_HTML_EXTRACT_CHARS}`);
  }
  return value;
}

function htmlArtifactFile(outputPath, actionIndex, requestedName) {
  const base = basename(outputPath, extname(outputPath));
  const name = requestedName ?? `html-${String(actionIndex).padStart(3, "0")}`;
  return resolve(dirname(outputPath), `${base}.artifacts`, `${name}.html`);
}

function pacingDelay(value, label) {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value < 0 || value > 60_000) {
    throw new CliError(`${label} must be an integer from 0 to 60000`);
  }
  return value;
}

function optionalBoolean(value, label) {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new CliError(`${label} must be a boolean`);
  }
  return value;
}

function optionalPositiveInt(value, label, max = 60_000) {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new CliError(`${label} must be an integer from 0 to ${max}`);
  }
  return value;
}

function optionalViewport(value, label) {
  if (value === undefined) {
    return undefined;
  }
  if (!isObject(value)) {
    throw new CliError(`${label} must be an object`);
  }
  if (!Number.isInteger(value.width) || value.width < 320 || value.width > 3840) {
    throw new CliError(`${label}.width must be an integer from 320 to 3840`);
  }
  if (!Number.isInteger(value.height) || value.height < 240 || value.height > 2160) {
    throw new CliError(`${label}.height must be an integer from 240 to 2160`);
  }
  return { width: value.width, height: value.height };
}

function validateAction(action, index) {
  const label = `actions[${index}]`;
  if (!isObject(action)) {
    throw new CliError(`${label} must be an object`);
  }
  const type = requireString(action.type, `${label}.type`);
  if (!ACTION_TYPES.has(type)) {
    throw new CliError(`${label}.type is unsupported: ${type}`);
  }
  if (type === "goto") {
    requireHttpUrl(action.url, `${label}.url`);
    if (action.wait_until !== undefined && !WAIT_UNTIL.has(action.wait_until)) {
      throw new CliError(`${label}.wait_until is unsupported`);
    }
    timeout(action.timeout_ms, `${label}.timeout_ms`);
    return;
  }
  if (type === "screenshot") {
    optionalName(action.name, `${label}.name`);
    if (action.full_page !== undefined && typeof action.full_page !== "boolean") {
      throw new CliError(`${label}.full_page must be a boolean`);
    }
    return;
  }
  if (type === "scroll") {
    optionalPositiveInt(action.delta_y, `${label}.delta_y`, 5_000);
    optionalPositiveInt(action.times, `${label}.times`, 20);
    return;
  }
  if (type === "solve-challenge") {
    optionalPositiveInt(action.timeout_ms, `${label}.timeout_ms`, MAX_TIMEOUT_MS);
    return;
  }
  if (type === "extract-html") {
    optionalName(action.name, `${label}.name`);
    maxHtmlChars(action.max_chars, `${label}.max_chars`);
    timeout(action.timeout_ms, `${label}.timeout_ms`);
    if (action.selector !== undefined) {
      requireSelector(action, label);
    }
    return;
  }
  requireSelector(action, label);
  timeout(action.timeout_ms, `${label}.timeout_ms`);
  if (type === "fill") {
    requireString(action.value, `${label}.value`);
  }
  if (type === "press") {
    requireString(action.key, `${label}.key`);
  }
  if (type === "select") {
    requireString(action.value, `${label}.value`);
  }
  if (type === "extract-text") {
    optionalName(action.name, `${label}.name`);
    maxChars(action.max_chars, `${label}.max_chars`);
  }
  if (type === "extract-attribute") {
    requireString(action.attribute, `${label}.attribute`);
    optionalName(action.name, `${label}.name`);
    maxChars(action.max_chars, `${label}.max_chars`);
  }
}

function validateBrowserOptions(browser) {
  if (browser === undefined) {
    return;
  }
  if (!isObject(browser)) {
    throw new CliError("browser must be an object");
  }
  if (browser.backend !== undefined) {
    const backend = requireString(browser.backend, "browser.backend");
    if (!["camofox", "playwright"].includes(backend)) {
      throw new CliError("browser.backend must be camofox or playwright");
    }
  }
  if (browser.camofox_url !== undefined) {
    requireString(browser.camofox_url, "browser.camofox_url");
  }
  optionalBoolean(browser.headless, "browser.headless");
  optionalBoolean(browser.stealth, "browser.stealth");
  optionalBoolean(browser.humanize, "browser.humanize");
  timeout(browser.timeout_ms, "browser.timeout_ms");
  optionalViewport(browser.viewport, "browser.viewport");
  if (browser.user_agent !== undefined) {
    requireString(browser.user_agent, "browser.user_agent");
  }
  if (browser.locale !== undefined) {
    requireString(browser.locale, "browser.locale");
  }
  if (browser.timezone_id !== undefined) {
    requireString(browser.timezone_id, "browser.timezone_id");
  }
  if (browser.user_data_dir !== undefined) {
    requireString(browser.user_data_dir, "browser.user_data_dir");
  }
  if (browser.session_user_id !== undefined) {
    const sessionUserId = requireString(browser.session_user_id, "browser.session_user_id");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(sessionUserId)) {
      throw new CliError(
        "browser.session_user_id must be 1-64 chars: letter/digit start, then [A-Za-z0-9._-]",
      );
    }
  }
  if (browser.import_cookies_path !== undefined) {
    requireString(browser.import_cookies_path, "browser.import_cookies_path");
  }
  if (browser.channel !== undefined) {
    const channel = requireString(browser.channel, "browser.channel");
    if (!["chrome", "chrome-beta", "chrome-dev", "msedge", "chromium"].includes(channel)) {
      throw new CliError(
        "browser.channel must be one of chrome, chrome-beta, chrome-dev, msedge, chromium",
      );
    }
  }
  if (browser.proxy !== undefined && browser.proxy !== false) {
    if (!isObject(browser.proxy)) {
      throw new CliError("browser.proxy must be an object or false");
    }
    requireString(browser.proxy.server, "browser.proxy.server");
    if (browser.proxy.username !== undefined) {
      requireString(browser.proxy.username, "browser.proxy.username");
    }
    if (browser.proxy.password !== undefined) {
      requireString(browser.proxy.password, "browser.proxy.password");
    }
    if (browser.proxy.bypass !== undefined) {
      requireString(browser.proxy.bypass, "browser.proxy.bypass");
    }
  }
  optionalBoolean(browser.wait_for_challenge, "browser.wait_for_challenge");
  optionalBoolean(browser.challenge_click, "browser.challenge_click");
  optionalPositiveInt(browser.challenge_timeout_ms, "browser.challenge_timeout_ms", MAX_TIMEOUT_MS);
  if (browser.pacing !== undefined) {
    if (!isObject(browser.pacing)) {
      throw new CliError("browser.pacing must be an object");
    }
    pacingDelay(browser.pacing.delay_ms, "browser.pacing.delay_ms");
    const minMs = optionalPositiveInt(browser.pacing.min_delay_ms, "browser.pacing.min_delay_ms");
    const maxMs = optionalPositiveInt(browser.pacing.max_delay_ms, "browser.pacing.max_delay_ms");
    if (minMs !== undefined && maxMs !== undefined && minMs > maxMs) {
      throw new CliError("browser.pacing.min_delay_ms must be <= max_delay_ms");
    }
  }
}

export function validateInput(document) {
  if (!isObject(document)) {
    throw new CliError("input must be a JSON object");
  }
  if (document.schema_version !== INPUT_SCHEMA) {
    throw new CliError(`input must use schema_version ${INPUT_SCHEMA}`);
  }
  requireString(document.run_id, "run_id");
  requireHttpUrl(document.start_url, "start_url");
  if (!Array.isArray(document.actions) || !document.actions.length) {
    throw new CliError("actions must be a non-empty array");
  }
  if (document.actions.length > MAX_ACTIONS) {
    throw new CliError(`actions must not exceed ${MAX_ACTIONS}`);
  }
  validateBrowserOptions(document.browser);
  document.actions.forEach(validateAction);
  return document;
}

export function validateOutput(document) {
  if (!isObject(document)) {
    throw new CliError("output must be a JSON object");
  }
  if (document.schema_version !== OUTPUT_SCHEMA) {
    throw new CliError(`output must use schema_version ${OUTPUT_SCHEMA}`);
  }
  if (document.status !== "succeeded") {
    throw new CliError("output.status must be succeeded");
  }
  requireString(document.run_id, "output.run_id");
  requireHttpUrl(document.start_url, "output.start_url");
  requireHttpUrl(document.final_url, "output.final_url");
  if (!isObject(document.tool)) {
    throw new CliError("output.tool must be an object");
  }
  requireString(document.tool.name, "output.tool.name");
  requireString(document.tool.version, "output.tool.version");
  if (!isObject(document.page)) {
    throw new CliError("output.page must be an object");
  }
  if (typeof document.page.title !== "string") {
    throw new CliError("output.page.title must be a string");
  }
  if (!isObject(document.automation_policy)) {
    throw new CliError("output.automation_policy must be an object");
  }
  for (const key of ["actions", "extractions", "artifacts"]) {
    if (!Array.isArray(document[key])) {
      throw new CliError(`output.${key} must be an array`);
    }
  }
  return document;
}

async function readJson(path, label) {
  let value;
  try {
    value = JSON.parse(await readFile(resolve(path), "utf8"));
  } catch {
    throw new CliError(`${label} is not valid JSON: ${path}`);
  }
  if (!isObject(value)) {
    throw new CliError(`${label} must be a JSON object: ${path}`);
  }
  return value;
}

async function writeJson(path, value) {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function timestamp() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function artifactFile(outputPath, actionIndex, requestedName) {
  const base = basename(outputPath, extname(outputPath));
  const name = requestedName ?? `action-${String(actionIndex).padStart(3, "0")}`;
  return resolve(dirname(outputPath), `${base}.artifacts`, `${name}.png`);
}

async function fileDigest(path) {
  const content = await readFile(path);
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function randomBetween(min, max) {
  if (max <= min) {
    return min;
  }
  return min + Math.random() * (max - min);
}

function randomIntBetween(min, max) {
  if (max <= min) {
    return min;
  }
  return randomInt(min, max + 1);
}

function proxyFromEnv() {
  const server = process.env.BROWSER_PROXY_SERVER?.trim();
  if (!server) {
    return undefined;
  }
  const username = process.env.BROWSER_PROXY_USERNAME?.trim();
  const password = process.env.BROWSER_PROXY_PASSWORD?.trim();
  const bypass = process.env.BROWSER_PROXY_BYPASS?.trim();
  return {
    server,
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
    ...(bypass ? { bypass } : {}),
  };
}

function isLoopbackUrl(url) {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

function resolveBackend(browserOptions = {}, startUrl) {
  if (browserOptions.backend) {
    return browserOptions.backend;
  }
  if (process.env.BROWSER_BACKEND) {
    return process.env.BROWSER_BACKEND.trim();
  }
  // Local HTTP tests stay on Playwright; remote sites use Camofox by default.
  if (startUrl && isLoopbackUrl(startUrl)) {
    return "playwright";
  }
  return "camofox";
}

function resolveBrowserPolicy(browserOptions = {}, startUrl) {
  const stealth = browserOptions.stealth ?? true;
  const humanize = browserOptions.humanize ?? true;
  const pacing = browserOptions.pacing ?? {};
  const fixedDelayMs = pacingDelay(pacing.delay_ms, "browser.pacing.delay_ms");
  const minDelayMs =
    optionalPositiveInt(pacing.min_delay_ms, "browser.pacing.min_delay_ms")
    ?? (humanize ? DEFAULT_HUMAN_MIN_MS : 0);
  const maxDelayMs =
    optionalPositiveInt(pacing.max_delay_ms, "browser.pacing.max_delay_ms")
    ?? (humanize ? DEFAULT_HUMAN_MAX_MS : fixedDelayMs ?? 0);
  // proxy: false disables env proxy; object configures explicit proxy.
  let inputProxy;
  if (browserOptions.proxy === false) {
    inputProxy = null;
  } else if (isObject(browserOptions.proxy)) {
    inputProxy = {
      server: browserOptions.proxy.server,
      username: browserOptions.proxy.username,
      password: browserOptions.proxy.password,
      bypass: browserOptions.proxy.bypass,
    };
  } else {
    inputProxy = undefined;
  }
  let proxy = inputProxy === null ? undefined : (inputProxy ?? proxyFromEnv());
  // Never send local test servers through a remote proxy by default.
  if (proxy && startUrl && isLoopbackUrl(startUrl) && inputProxy === undefined) {
    proxy = undefined;
  }
  const backend = resolveBackend(browserOptions, startUrl);
  return {
    backend,
    camofoxUrl: browserOptions.camofox_url || process.env.BROWSER_CAMOFOX_URL || undefined,
    sessionUserId:
      browserOptions.session_user_id
      || process.env.BROWSER_CAMOFOX_USER_ID
      || undefined,
    importCookiesPath:
      browserOptions.import_cookies_path
      || process.env.BROWSER_IMPORT_COOKIES_PATH
      || undefined,
    headless: browserOptions.headless ?? true,
    stealth,
    humanize,
    fixedDelayMs,
    minDelayMs,
    maxDelayMs: Math.max(minDelayMs, maxDelayMs),
    timeoutMs: timeout(browserOptions.timeout_ms, "browser.timeout_ms"),
    viewport: optionalViewport(browserOptions.viewport, "browser.viewport") ?? DEFAULT_VIEWPORT,
    userAgent: browserOptions.user_agent ?? DEFAULT_USER_AGENT,
    locale: browserOptions.locale ?? DEFAULT_LOCALE,
    timezoneId: browserOptions.timezone_id ?? DEFAULT_TIMEZONE,
    userDataDir: browserOptions.user_data_dir,
    channel: browserOptions.channel ?? undefined,
    proxy,
    waitForChallenge: browserOptions.wait_for_challenge ?? true,
    challengeClick: browserOptions.challenge_click ?? true,
    challengeTimeoutMs:
      optionalPositiveInt(browserOptions.challenge_timeout_ms, "browser.challenge_timeout_ms", MAX_TIMEOUT_MS)
      ?? 45_000,
  };
}

async function humanDelay(policy, minMs, maxMs) {
  if (!policy.humanize && policy.fixedDelayMs === undefined) {
    return;
  }
  const min = minMs ?? policy.minDelayMs;
  const max = maxMs ?? policy.maxDelayMs;
  if (policy.fixedDelayMs !== undefined && !policy.humanize) {
    if (policy.fixedDelayMs > 0) {
      await delay(policy.fixedDelayMs);
    }
    return;
  }
  const waitMs = Math.round(randomBetween(min, max));
  if (waitMs > 0) {
    await delay(waitMs);
  }
}

function cubicBezier(t, p0, p1, p2, p3) {
  const u = 1 - t;
  return (u ** 3) * p0 + 3 * (u ** 2) * t * p1 + 3 * u * (t ** 2) * p2 + (t ** 3) * p3;
}

async function humanMove(page, x, y, steps = 24) {
  const start = await page.evaluate(() => ({
    x: window.__clueMouseX ?? 0,
    y: window.__clueMouseY ?? 0,
  })).catch(() => ({ x: 0, y: 0 }));
  const control1 = {
    x: start.x + (x - start.x) * randomBetween(0.15, 0.45) + randomBetween(-40, 40),
    y: start.y + (y - start.y) * randomBetween(0.05, 0.35) + randomBetween(-30, 30),
  };
  const control2 = {
    x: start.x + (x - start.x) * randomBetween(0.55, 0.85) + randomBetween(-40, 40),
    y: start.y + (y - start.y) * randomBetween(0.65, 0.95) + randomBetween(-30, 30),
  };
  const totalSteps = Math.max(12, steps + randomIntBetween(-4, 10));
  for (let index = 1; index <= totalSteps; index += 1) {
    const t = index / totalSteps;
    // Ease-in-out so the cursor accelerates then decelerates.
    const eased = t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
    const pointX = cubicBezier(eased, start.x, control1.x, control2.x, x) + randomBetween(-1.2, 1.2);
    const pointY = cubicBezier(eased, start.y, control1.y, control2.y, y) + randomBetween(-1.2, 1.2);
    await page.mouse.move(pointX, pointY);
    await delay(randomBetween(4, 18));
  }
  await page.mouse.move(x, y);
  await page.evaluate(([mx, my]) => {
    window.__clueMouseX = mx;
    window.__clueMouseY = my;
  }, [x, y]).catch(() => {});
  await delay(randomBetween(80, 280));
}

async function humanClick(page, element, actionTimeout) {
  const box = await element.boundingBox();
  if (!box || box.width < 2 || box.height < 2) {
    await element.click({ timeout: actionTimeout });
    return;
  }
  const padX = Math.min(10, Math.max(1, box.width / 4));
  const padY = Math.min(10, Math.max(1, box.height / 4));
  const targetX = box.x + randomBetween(padX, Math.max(padX, box.width - padX));
  const targetY = box.y + randomBetween(padY, Math.max(padY, box.height - padY));
  await humanMove(page, targetX, targetY);
  await delay(randomBetween(120, 420));
  await page.mouse.click(targetX, targetY);
}

async function humanType(page, element, text) {
  await element.click({ timeout: 5_000 });
  await delay(randomBetween(200, 600));
  // Clear existing value without a single bulk fill.
  const current = await element.inputValue().catch(() => "");
  if (current) {
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await delay(randomBetween(40, 120));
    await page.keyboard.press("Backspace");
    await delay(randomBetween(80, 200));
  }
  for (const char of text) {
    if (Math.random() < 0.04 && /[a-zA-Z0-9]/.test(char)) {
      const wrong = String.fromCharCode(char.charCodeAt(0) + 1);
      await page.keyboard.type(wrong, { delay: randomBetween(30, 90) });
      await delay(randomBetween(80, 220));
      await page.keyboard.press("Backspace");
      await delay(randomBetween(60, 160));
    }
    await page.keyboard.type(char, { delay: randomBetween(40, 160) });
    if (Math.random() < 0.08) {
      await delay(randomBetween(120, 380));
    }
  }
}

async function humanScroll(page, times = randomIntBetween(2, 4), deltaY) {
  const count = Math.max(1, times);
  for (let index = 0; index < count; index += 1) {
    const scrollY = deltaY ?? randomIntBetween(180, 720);
    await page.mouse.wheel(0, scrollY);
    await delay(randomBetween(350, 1_200));
    if (Math.random() > 0.7) {
      await page.mouse.wheel(0, -randomIntBetween(40, 160));
      await delay(randomBetween(200, 600));
    }
  }
}

async function actionElement(page, selector, actionTimeout) {
  const element = await page.waitForSelector(selector, {
    state: "attached",
    timeout: actionTimeout,
  });
  if (!element) {
    throw new CliError(`selector did not match an attached element: ${selector}`);
  }
  return element;
}

function downloadArtifactPath(outputPath, suggestedName, index = 0) {
  const base = basename(outputPath, extname(outputPath));
  const safeName = (suggestedName || `download-${String(index).padStart(3, "0")}`)
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .slice(0, 120) || `download-${index}`;
  return resolve(dirname(outputPath), `${base}.artifacts`, safeName);
}

async function recordDownload(download, outputPath, artifacts, index = 0) {
  const suggested = download.suggestedFilename();
  const path = downloadArtifactPath(outputPath, suggested, index);
  await mkdir(dirname(path), { recursive: true });
  await download.saveAs(path);
  const info = {
    kind: "download",
    path,
    filename: suggested,
    sha256: await fileDigest(path),
    bytes: (await stat(path)).size,
  };
  artifacts.push(info);
  return info;
}

function filenameFromUrl(url, fallback = "download.bin") {
  try {
    const pathname = new URL(url).pathname;
    const base = basename(pathname);
    if (base && base !== "/" && base !== ".") {
      return base;
    }
  } catch {
    // ignore
  }
  return fallback;
}

function filenameFromDisposition(disposition) {
  if (!disposition) {
    return undefined;
  }
  const utfMatch = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utfMatch?.[1]) {
    try {
      return decodeURIComponent(utfMatch[1].trim().replace(/^"|"$/g, ""));
    } catch {
      return utfMatch[1].trim().replace(/^"|"$/g, "");
    }
  }
  const plainMatch = disposition.match(/filename="?([^";]+)"?/i);
  return plainMatch?.[1]?.trim();
}

function looksLikePdf(body) {
  if (!body || body.length < 5) {
    return false;
  }
  // PDF magic: "%PDF-"
  return body[0] === 0x25 && body[1] === 0x50 && body[2] === 0x44 && body[3] === 0x46 && body[4] === 0x2d;
}

function looksLikeHtml(body) {
  if (!body || body.length < 15) {
    return false;
  }
  const head = body.subarray(0, Math.min(body.length, 256)).toString("utf8").trimStart().toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html") || head.startsWith("<head");
}

async function maybeSaveResponseBody(response, url, outputPath, artifacts) {
  if (!response) {
    return null;
  }
  // Never treat access-control / rate-limit HTML challenge pages as downloads.
  const status = response.status();
  if (status === 401 || status === 403 || status === 429) {
    return null;
  }
  const headers = response.headers();
  const contentType = (headers["content-type"] ?? "").toLowerCase();
  const disposition = headers["content-disposition"] ?? "";
  const typeIsPdf = contentType.includes("application/pdf");
  const typeIsHtml = contentType.includes("text/html") || contentType.includes("text/plain");
  const isAttachment = /attachment/i.test(disposition);
  const typeIsBinary =
    typeIsPdf
    || isAttachment
    || contentType.includes("application/octet-stream")
    || contentType.includes("application/zip")
    || contentType.includes("application/msword")
    || contentType.includes("officedocument");
  // URL ending in .pdf alone is not enough — Cloudflare denial pages often keep the .pdf path.
  if (!typeIsBinary && !/\.pdf($|\?)/i.test(url)) {
    return null;
  }
  if (typeIsHtml && !typeIsPdf && !isAttachment) {
    return null;
  }
  let body;
  try {
    body = await response.body();
  } catch {
    return null;
  }
  if (!body || body.length === 0) {
    return null;
  }
  // Sniff content so HTML challenge pages are never stored as .pdf artifacts.
  if (looksLikeHtml(body) && !looksLikePdf(body)) {
    return null;
  }
  const isPdf = typeIsPdf || looksLikePdf(body);
  if (!typeIsBinary && !isPdf) {
    return null;
  }
  const suggested =
    filenameFromDisposition(disposition)
    || filenameFromUrl(url, isPdf ? "document.pdf" : "download.bin");
  const path = downloadArtifactPath(outputPath, suggested, artifacts.length);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body);
  const info = {
    kind: "download",
    path,
    filename: suggested,
    content_type: contentType || undefined,
    http_status: status,
    sha256: await fileDigest(path),
    bytes: (await stat(path)).size,
  };
  artifacts.push(info);
  return info;
}

async function pageLooksLikeChallenge(page) {
  try {
    return await page.evaluate(() => {
      const title = (document.title || "").toLowerCase();
      const body = (document.body?.innerText || "").slice(0, 2_000).toLowerCase();
      const html = (document.documentElement?.innerHTML || "").slice(0, 8_000).toLowerCase();
      const markers = [
        "just a moment",
        "checking your browser",
        "security check required",
        "cf-browser-verification",
        "cf-challenge",
        "challenge-platform",
        "enable javascript and cookies to continue",
        "attention required",
        "verify you are human",
        "performing security verification",
        "cf-turnstile",
        "challenge-error-text",
      ];
      const haystack = `${title}\n${body}\n${html}`;
      return markers.some((marker) => haystack.includes(marker));
    });
  } catch {
    return false;
  }
}

async function tryClickLocator(page, locator, label, clicks) {
  try {
    const count = await locator.count();
    if (!count) {
      return false;
    }
    const target = locator.first();
    const box = await target.boundingBox().catch(() => null);
    if (box && box.width >= 2 && box.height >= 2) {
      const x = box.x + randomBetween(box.width * 0.3, box.width * 0.7);
      const y = box.y + randomBetween(box.height * 0.3, box.height * 0.7);
      await page.mouse.move(x, y, { steps: randomIntBetween(8, 18) });
      await delay(randomBetween(40, 140));
      await page.mouse.click(x, y, { delay: randomIntBetween(30, 90) });
    } else {
      await target.click({ timeout: 2_500, force: true });
    }
    clicks.push(label);
    return true;
  } catch {
    return false;
  }
}

async function humanClickPoint(page, x, y, label, clicks) {
  await page.mouse.move(x, y, { steps: randomIntBetween(12, 28) });
  await delay(randomBetween(80, 220));
  await page.mouse.click(x, y, { delay: randomIntBetween(40, 120) });
  clicks.push(`${label}@${Math.round(x)},${Math.round(y)}`);
  await delay(randomBetween(250, 700));
}

/**
 * Build a structured layout map of challenge-related nodes and iframes.
 * Used to derive checkbox coordinates without blind center-clicks.
 */
async function captureChallengeLayout(page) {
  return page.evaluate(() => {
    const boxOf = (el) => {
      const r = el.getBoundingClientRect();
      return {
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        cx: r.x + r.width / 2,
        cy: r.y + r.height / 2,
      };
    };
    const nodes = [];
    const selectors = [
      ".challenge-captcha",
      ".challenge-content",
      ".cf-turnstile",
      "#challenge-stage",
      "#challenge-form",
      "iframe",
      "input[type='checkbox']",
      "label.ctp-checkbox-label",
    ];
    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        const box = boxOf(el);
        if (box.width < 2 || box.height < 2) {
          continue;
        }
        nodes.push({
          selector,
          tag: el.tagName,
          id: el.id || "",
          className: String(el.className || "").slice(0, 100),
          src: (el.getAttribute("src") || "").slice(0, 160),
          title: el.getAttribute("title") || "",
          ...box,
        });
      }
    }
    return {
      title: document.title,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      body: (document.body?.innerText || "").replace(/\s+/g, " ").slice(0, 400),
      nodes,
    };
  });
}

/** Built-in layout → click points (re-export for tests). */
export function clickPointsFromLayout(layout) {
  return helperPointsFromLayout(layout).map((point) => ({
    ...point,
    // Light jitter so repeated challenges are not pixel-identical.
    x: point.x + randomBetween(-2, 2),
    y: point.y + randomBetween(-2, 2),
  }));
}

/**
 * Built-in snapshot parser (layout + optional vision API).
 * Always on — no external BROWSER_CHALLENGE_VISION_CMD required.
 */
async function clickPointsFromBuiltInVision(screenshotPath, layout = null) {
  if (!screenshotPath && !layout) {
    return [];
  }
  try {
    const result = await resolveChallengeClickPoints(screenshotPath, layout);
    return (result.points || []).map((point, index) => ({
      x: point.x,
      y: point.y,
      label: point.label || `built-in-${result.source || "vision"}-${index}`,
    }));
  } catch {
    return [];
  }
}

async function saveChallengeSnapshot(page, outputPath, index = 0) {
  if (!outputPath) {
    const dir = join(tmpdir(), "clue-browser-challenge");
    await mkdir(dir, { recursive: true });
    const shot = join(dir, `challenge-${index}.png`);
    const layoutPath = join(dir, `challenge-${index}.layout.json`);
    const layout = await captureChallengeLayout(page);
    await page.screenshot({ path: shot, fullPage: false });
    await writeFile(layoutPath, `${JSON.stringify(layout, null, 2)}\n`);
    return { shot, layoutPath, layout };
  }
  const base = basename(outputPath, extname(outputPath));
  const dir = resolve(dirname(outputPath), `${base}.artifacts`);
  await mkdir(dir, { recursive: true });
  const shot = join(dir, `challenge-${String(index).padStart(2, "0")}.png`);
  const layoutPath = join(dir, `challenge-${String(index).padStart(2, "0")}.layout.json`);
  const layout = await captureChallengeLayout(page);
  await page.screenshot({ path: shot, fullPage: false });
  await writeFile(layoutPath, `${JSON.stringify(layout, null, 2)}\n`);
  return { shot, layoutPath, layout };
}

/**
 * Attempt interactive challenge clicks using:
 * 1) built-in snapshot parser (layout geometry + optional vision API)
 * 2) selector / iframe fallbacks
 */
async function clickChallengeWidgets(page, policy, options = {}) {
  if (!policy.challengeClick) {
    return [];
  }
  const clicks = [];
  const { outputPath, snapshotIndex = 0 } = options;

  let snapshot;
  try {
    snapshot = await saveChallengeSnapshot(page, outputPath, snapshotIndex);
    clicks.push(`snapshot:${snapshot.shot}`);
  } catch {
    snapshot = null;
  }

  // 1) Built-in layout/vision coordinate picker (no external command).
  const builtInPoints = snapshot
    ? await clickPointsFromBuiltInVision(snapshot.shot, snapshot.layout)
    : [];
  for (const point of builtInPoints) {
    try {
      await humanClickPoint(page, point.x, point.y, point.label, clicks);
    } catch {
      // ignore
    }
  }

  // 2) Main-page selectors (Turnstile host + common CF chrome).
  for (const selector of CHALLENGE_PAGE_SELECTORS) {
    const locator = page.locator(selector);
    if (await tryClickLocator(page, locator, `page:${selector}`, clicks)) {
      await delay(randomBetween(250, 700));
    }
  }

  // 3) Challenge iframes — click LEFT checkbox band, not body center.
  for (const frame of page.frames()) {
    const frameUrl = frame.url();
    const isChallengeFrame = /challenges\.cloudflare\.com|turnstile|cdn-cgi\/challenge|cloudflare/i.test(frameUrl);
    if (!isChallengeFrame) {
      continue;
    }
    try {
      const element = frame.frameElement();
      const box = element ? await element.boundingBox() : null;
      if (box && box.width >= 8 && box.height >= 8) {
        const x = box.x + Math.min(32, box.width * 0.12) + randomBetween(-2, 3);
        const y = box.y + box.height * 0.5 + randomBetween(-3, 3);
        await humanClickPoint(page, x, y, `frame-left:${frameUrl.slice(0, 40)}`, clicks);
      }
    } catch {
      // ignore
    }
    for (const selector of ["input[type='checkbox']", "label", ".ctp-checkbox-label", "#challenge-stage"]) {
      try {
        const locator = frame.locator(selector);
        const count = await locator.count();
        if (!count) {
          continue;
        }
        const target = locator.first();
        const box = await target.boundingBox().catch(() => null);
        if (box && box.width >= 2 && box.height >= 2) {
          const x = box.x + Math.min(20, box.width * 0.35);
          const y = box.y + box.height * 0.5;
          await humanClickPoint(page, x, y, `frame-el:${selector}`, clicks);
        }
      } catch {
        // ignore
      }
    }
  }

  if (policy.humanize) {
    try {
      await page.mouse.wheel(0, randomIntBetween(20, 120));
    } catch {
      // ignore
    }
  }
  return clicks;
}

/**
 * Wait for Cloudflare-style interstitials; optionally click interactive widgets.
 * Returns whether the challenge cleared. Managed/image CAPTCHAs may still remain.
 */
async function waitForChallengeClear(page, policy, options = {}) {
  if (!policy.waitForChallenge) {
    return { waited: false, cleared: true, challenge: false, clicks: [] };
  }
  const challenge = await pageLooksLikeChallenge(page);
  if (!challenge) {
    return { waited: false, cleared: true, challenge: false, clicks: [] };
  }
  const deadline = Date.now() + policy.challengeTimeoutMs;
  let cleared = false;
  const allClicks = [];
  let attempt = 0;
  while (Date.now() < deadline) {
    if (policy.challengeClick && attempt % 2 === 0) {
      const clicks = await clickChallengeWidgets(page, policy, {
        outputPath: options.outputPath,
        snapshotIndex: attempt,
      });
      allClicks.push(...clicks);
    }
    attempt += 1;
    // Light human-like activity while CF JS runs.
    if (policy.humanize) {
      try {
        await page.mouse.wheel(0, randomIntBetween(40, 180));
        await page.mouse.move(
          randomIntBetween(80, 900),
          randomIntBetween(80, 600),
          { steps: randomIntBetween(5, 14) },
        );
      } catch {
        // ignore
      }
    }
    await delay(randomBetween(900, 1_800));
    if (!(await pageLooksLikeChallenge(page))) {
      // Confirm it stayed clear for a beat (avoid mid-redirect flicker).
      await delay(500);
      if (!(await pageLooksLikeChallenge(page))) {
        cleared = true;
        break;
      }
    }
  }
  return {
    waited: true,
    cleared,
    challenge: true,
    clicks: allClicks,
  };
}

async function navigate(page, url, options, outputPath, artifacts, policy) {
  const navTimeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
  let downloadHandler;
  const downloadPromise = new Promise((resolve) => {
    downloadHandler = (download) => resolve({ kind: "download", download });
    page.once("download", downloadHandler);
  });

  try {
    let response = null;
    try {
      response = await page.goto(url, options);
    } catch (error) {
      // Chromium may throw on HTTP 4xx while still rendering a CF challenge page.
      if (
        error instanceof Error
        && (
          error.message.includes("ERR_HTTP_RESPONSE_CODE_FAILURE")
          || error.message.includes("Download is starting")
        )
      ) {
        if (error.message.includes("Download is starting")) {
          const download = await Promise.race([
            downloadPromise,
            delay(navTimeout).then(() => null),
          ]);
          if (download?.kind === "download") {
            await recordDownload(download.download, outputPath, artifacts, artifacts.length);
          }
          return null;
        }
        // Fall through: page may still be on a challenge document.
      } else {
        throw error;
      }
    }
    // Brief window for a late download event after a completed navigation.
    const lateDownload = await Promise.race([
      downloadPromise,
      delay(250).then(() => null),
    ]);
    if (lateDownload?.kind === "download") {
      await recordDownload(lateDownload.download, outputPath, artifacts, artifacts.length);
    } else {
      await maybeSaveResponseBody(response, url, outputPath, artifacts);
      if (policy) {
        await waitForChallengeClear(page, policy, { outputPath });
      }
    }
    return response;
  } catch (error) {
    if (error instanceof Error && error.message.includes("Download is starting")) {
      const download = await Promise.race([
        downloadPromise,
        delay(navTimeout).then(() => null),
      ]);
      if (download?.kind === "download") {
        await recordDownload(download.download, outputPath, artifacts, artifacts.length);
      }
      return null;
    }
    throw error;
  } finally {
    if (downloadHandler) {
      page.off("download", downloadHandler);
    }
  }
}

async function executeAction(page, action, index, outputPath, artifacts, extractions, policy) {
  const actionTimeout = timeout(action.timeout_ms, `actions[${index}].timeout_ms`);
  const result = { index, type: action.type, status: "succeeded" };
  if (action.type === "goto") {
    await navigate(page, action.url, {
      timeout: actionTimeout,
      waitUntil: action.wait_until ?? "domcontentloaded",
    }, outputPath, artifacts, policy);
    if (policy.humanize) {
      await humanDelay(policy, 500, 1_500);
      if (Math.random() < 0.45) {
        await humanScroll(page, randomIntBetween(1, 2));
      }
    }
  } else if (action.type === "screenshot") {
    const path = artifactFile(outputPath, index, optionalName(action.name, `actions[${index}].name`));
    await mkdir(dirname(path), { recursive: true });
    await page.screenshot({ path, fullPage: action.full_page ?? true });
    artifacts.push({
      kind: "screenshot",
      path,
      sha256: await fileDigest(path),
      bytes: (await stat(path)).size,
    });
    result.artifact_path = path;
  } else if (action.type === "extract-html") {
    const name = optionalName(action.name, `actions[${index}].name`);
    const limit = maxHtmlChars(action.max_chars, `actions[${index}].max_chars`);
    let html;
    if (action.selector) {
      const element = await actionElement(page, action.selector, actionTimeout);
      html = await element.evaluate((el) => el.outerHTML);
    } else {
      html = await page.content();
    }
    const path = htmlArtifactFile(outputPath, index, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, html, "utf8");
    artifacts.push({
      kind: "html",
      path,
      sha256: await fileDigest(path),
      bytes: (await stat(path)).size,
    });
    extractions.push({
      name: name ?? `html-${index}`,
      kind: "html",
      value: html.slice(0, limit),
      path,
    });
    result.artifact_path = path;
  } else if (action.type === "scroll") {
    await humanScroll(
      page,
      action.times ?? (policy.humanize ? randomIntBetween(2, 4) : 1),
      action.delta_y,
    );
  } else if (action.type === "solve-challenge") {
    const previousTimeout = policy.challengeTimeoutMs;
    if (action.timeout_ms !== undefined) {
      policy.challengeTimeoutMs = timeout(action.timeout_ms, `actions[${index}].timeout_ms`);
    }
    // Force wait + click for this explicit action.
    const previousWait = policy.waitForChallenge;
    const previousClick = policy.challengeClick;
    policy.waitForChallenge = true;
    policy.challengeClick = true;
    const outcome = await waitForChallengeClear(page, policy, { outputPath });
    policy.waitForChallenge = previousWait;
    policy.challengeClick = previousClick;
    policy.challengeTimeoutMs = previousTimeout;
    result.challenge = {
      detected: outcome.challenge,
      cleared: outcome.cleared,
      clicks: outcome.clicks,
    };
    if (outcome.challenge && !outcome.cleared) {
      result.status = "unresolved";
    }
  } else {
    const element = await actionElement(page, action.selector, actionTimeout);
    if (action.type === "click") {
      if (policy.humanize) {
        await humanClick(page, element, actionTimeout);
      } else {
        await element.click({ timeout: actionTimeout });
      }
    } else if (action.type === "fill") {
      if (policy.humanize) {
        await humanType(page, element, action.value);
      } else {
        await element.fill(action.value, { timeout: actionTimeout });
      }
    } else if (action.type === "press") {
      if (policy.humanize) {
        await humanClick(page, element, actionTimeout);
        await humanDelay(policy, 100, 300);
        await page.keyboard.press(action.key);
      } else {
        await element.press(action.key, { timeout: actionTimeout });
      }
    } else if (action.type === "select") {
      await element.selectOption(action.value, { timeout: actionTimeout });
    } else if (action.type === "check") {
      if (policy.humanize) {
        await humanClick(page, element, actionTimeout);
      } else {
        await element.check({ timeout: actionTimeout });
      }
    } else if (action.type === "wait-for") {
      // actionElement already waited for a DOM-attached selector.
      if (policy.humanize) {
        await humanDelay(policy, 200, 700);
      }
    } else if (action.type === "extract-text") {
      const value = (await element.textContent() ?? "").slice(
        0,
        maxChars(action.max_chars, `actions[${index}].max_chars`),
      );
      extractions.push({ name: action.name ?? `extraction-${index}`, kind: "text", value });
    } else if (action.type === "extract-attribute") {
      const value = (await element.getAttribute(action.attribute) ?? "").slice(
        0,
        maxChars(action.max_chars, `actions[${index}].max_chars`),
      );
      extractions.push({
        name: action.name ?? `extraction-${index}`,
        kind: "attribute",
        attribute: action.attribute,
        value,
      });
    }
  }
  result.url = page.url();
  return result;
}

async function loadChromium(stealthEnabled) {
  if (stealthEnabled) {
    try {
      const { chromium } = await import("playwright-extra");
      const StealthPlugin = (await import("puppeteer-extra-plugin-stealth")).default;
      chromium.use(StealthPlugin());
      return chromium;
    } catch {
      throw new CliError(
        "Stealth dependencies are not installed; run clue-browser setup first",
      );
    }
  }
  try {
    const { chromium } = await import("playwright");
    return chromium;
  } catch {
    throw new CliError("Playwright is not installed; run clue-browser setup first");
  }
}

function contextOptions(policy) {
  const options = {
    acceptDownloads: true,
    viewport: policy.viewport,
    userAgent: policy.userAgent,
    locale: policy.locale,
    timezoneId: policy.timezoneId,
  };
  if (policy.proxy) {
    options.proxy = Object.fromEntries(
      Object.entries(policy.proxy).filter(([, value]) => value !== undefined),
    );
  }
  return options;
}

async function launchBrowser(chromium, policy) {
  const launchOptions = {
    headless: policy.headless,
    args: policy.stealth ? STEALTH_LAUNCH_ARGS : ["--no-sandbox", "--disable-dev-shm-usage"],
  };
  const executablePath = process.env.BROWSER_EXECUTABLE_PATH?.trim();
  if (executablePath && (!policy.channel || policy.channel === "chromium")) {
    launchOptions.executablePath = executablePath;
  }
  if (policy.channel && policy.channel !== "chromium") {
    launchOptions.channel = policy.channel;
  }
  // Playwright accepts proxy on launch when not using a context proxy in some setups;
  // set it on both for reliability.
  if (policy.proxy) {
    launchOptions.proxy = Object.fromEntries(
      Object.entries(policy.proxy).filter(([, value]) => value !== undefined),
    );
  }
  if (policy.userDataDir) {
    const context = await chromium.launchPersistentContext(policy.userDataDir, {
      ...launchOptions,
      ...contextOptions(policy),
    });
    if (policy.stealth) {
      await context.addInitScript(STEALTH_INIT_SCRIPT);
    }
    const page = context.pages()[0] ?? await context.newPage();
    return { browser: context, page, close: () => context.close() };
  }
  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext(contextOptions(policy));
  if (policy.stealth) {
    await context.addInitScript(STEALTH_INIT_SCRIPT);
  }
  const page = await context.newPage();
  return {
    browser,
    page,
    close: async () => {
      await context.close();
      await browser.close();
    },
  };
}

function pacingDescription(policy) {
  if (policy.humanize) {
    return `humanized random delay ${policy.minDelayMs}-${policy.maxDelayMs} ms between actions; human click/type/scroll`;
  }
  if (policy.fixedDelayMs !== undefined) {
    return `${policy.fixedDelayMs} ms fixed delay between declared actions`;
  }
  return "no inter-action delay";
}

export async function commandRun(inputPath, outputPath) {
  const input = validateInput(await readJson(inputPath, "input"));
  const policy = resolveBrowserPolicy(input.browser, input.start_url);
  if (policy.backend === "camofox") {
    const { commandRunCamofox } = await import("./camofox-backend.mjs");
    const toolVersion = (await readFile(new URL("./VERSION", import.meta.url), "utf8")).trim();
    return commandRunCamofox({
      input,
      outputPath,
      policy,
      toolVersion,
      validateOutput,
      TOOL_NAME,
      OUTPUT_SCHEMA,
    });
  }
  const chromium = await loadChromium(policy.stealth);
  const startedAt = timestamp();
  const session = await launchBrowser(chromium, policy);
  const { page } = session;
  page.setDefaultTimeout(policy.timeoutMs);
  page.setDefaultNavigationTimeout(policy.timeoutMs);
  const artifacts = [];
  const extractions = [];
  const actions = [];
  try {
    const startChallenge = await (async () => {
      await navigate(
        page,
        input.start_url,
        { waitUntil: "domcontentloaded", timeout: policy.timeoutMs },
        outputPath,
        artifacts,
        policy,
      );
      // navigate already waited/clicked once; capture final challenge state for policy log
      const still = await pageLooksLikeChallenge(page);
      return { challenge: still, cleared: !still };
    })();
    const downloadedOnly = artifacts.some((item) => item.kind === "download")
      && (page.url() === "about:blank" || page.url() === "chrome://downloads/" || !page.url());
    if (policy.humanize && !downloadedOnly && !startChallenge.challenge) {
      await humanDelay(policy, 600, 2_000);
      if (Math.random() < 0.55) {
        await humanScroll(page, randomIntBetween(1, 3));
      }
    }
    for (let offset = 0; offset < input.actions.length; offset += 1) {
      const action = input.actions[offset];
      // After a pure download navigation, interactive page actions may be empty.
      if (downloadedOnly && !["screenshot", "extract-text", "extract-attribute", "extract-html", "scroll"].includes(action.type)
        && action.type !== "goto") {
        actions.push({
          index: offset + 1,
          type: action.type,
          status: "skipped",
          reason: "no interactive page after download",
        });
        continue;
      }
      try {
        actions.push(
          await executeAction(
            page,
            action,
            offset + 1,
            outputPath,
            artifacts,
            extractions,
            policy,
          ),
        );
      } catch (error) {
        if (downloadedOnly && action.type === "screenshot") {
          actions.push({
            index: offset + 1,
            type: action.type,
            status: "skipped",
            reason: "page unavailable after download",
          });
          continue;
        }
        throw error;
      }
      if (offset + 1 < input.actions.length) {
        await humanDelay(policy);
      }
    }
    let pageTitle = "";
    let finalUrl = input.start_url;
    try {
      pageTitle = await page.title();
      finalUrl = page.url() || input.start_url;
    } catch {
      // Page may be gone after a download-only navigation.
      finalUrl = input.start_url;
    }
    if (!/^https?:\/\//i.test(finalUrl)) {
      finalUrl = input.start_url;
    }
    const output = {
      schema_version: OUTPUT_SCHEMA,
      tool: {
        name: TOOL_NAME,
        version: (await readFile(new URL("./VERSION", import.meta.url), "utf8")).trim(),
      },
      status: "succeeded",
      run_id: input.run_id,
      started_at: startedAt,
      finished_at: timestamp(),
      start_url: input.start_url,
      final_url: finalUrl,
      page: { title: pageTitle },
      actions,
      extractions,
      artifacts,
      automation_policy: {
        backend: "playwright",
        stealth: policy.stealth
          ? "playwright-extra stealth plugin + AutomationControlled launch args + init script"
          : "disabled",
        humanize: policy.humanize
          ? "random think-time, cubic-bezier mouse moves, per-char typing, light scroll"
          : "disabled",
        pacing: pacingDescription(policy),
        locale: policy.locale,
        timezone_id: policy.timezoneId,
        viewport: policy.viewport,
        channel: policy.channel ?? "chromium",
        proxy: policy.proxy?.server ?? null,
        wait_for_challenge: policy.waitForChallenge
          ? `poll up to ${policy.challengeTimeoutMs} ms for Cloudflare-style interstitials`
          : "disabled",
        challenge_click: policy.challengeClick
          ? "click Turnstile/checkbox/iframe widgets while waiting"
          : "disabled",
        challenge_on_start: startChallenge.challenge
          ? "still present after wait/click"
          : "absent or cleared",
        downloads: "accepted as artifacts (download events and binary response bodies)",
      },
    };
    validateOutput(output);
    await writeJson(outputPath, output);
    return {
      status: "succeeded",
      output: resolve(outputPath),
      action_count: actions.length,
      download_count: artifacts.filter((item) => item.kind === "download").length,
      backend: "playwright",
    };
  } finally {
    await session.close();
  }
}

function argumentValue(argumentsList, name) {
  const index = argumentsList.indexOf(name);
  if (index === -1 || index + 1 >= argumentsList.length) {
    throw new CliError(`${name} is required`);
  }
  return argumentsList[index + 1];
}

async function main(argumentsList) {
  const [command, ...rest] = argumentsList;
  if (command === "workflow") {
    const [workflowCommand, ...workflowArgs] = rest;
    if (workflowCommand !== "capture") {
      throw new CliError(`unsupported workflow command: ${workflowCommand || "(missing)"}`);
    }
    const inputPath = argumentValue(workflowArgs, "--input");
    const outputPath = argumentValue(workflowArgs, "--output");
    const request = await readJson(inputPath, "workflow input");
    const values = request.input;
    if (!values || typeof values !== "object" || Array.isArray(values)) {
      throw new CliError("workflow input must contain an input object");
    }
    let captureUrl = values.url;
    if (typeof captureUrl !== "string" && typeof values.item === "string") {
      try {
        const item = JSON.parse(values.item);
        captureUrl = item.url || item.source_url || item.payload?.url || item.payload?.source_url;
        if (typeof captureUrl !== "string") {
          const links = item.payload?.pdf_links?.candidates;
          captureUrl = Array.isArray(links) ? links[0]?.url : undefined;
        }
      } catch {
        captureUrl = undefined;
      }
    }
    if (typeof captureUrl !== "string" || !/^https?:\/\//i.test(captureUrl)) {
      throw new CliError("capture input requires an HTTP url");
    }
    const nestedPath = `${outputPath}.browser-input.json`;
    const browserOutputPath = `${outputPath}.browser-output.json`;
    await writeJson(nestedPath, {
      schema_version: INPUT_SCHEMA,
      run_id: request.runId || `capture-${Date.now()}`,
      start_url: captureUrl,
      browser: values.browser || undefined,
      actions: [{ type: "wait-for", selector: "body", timeout_ms: 30_000 }],
    });
    try {
      const summary = await commandRun(nestedPath, browserOutputPath);
      const browserOutput = await readJson(browserOutputPath, "browser output");
      const pdf = Array.isArray(browserOutput.artifacts)
        ? browserOutput.artifacts.find((artifact) =>
          artifact && artifact.kind === "download" && /\.pdf$/i.test(artifact.path || artifact.filename || ""))
        : undefined;
      await writeJson(outputPath, {
        pdfPath: pdf?.path || null,
        captureStatus: pdf ? "succeeded" : "no-pdf",
        browserOutputRef: resolve(browserOutputPath),
      });
      process.stdout.write(`${JSON.stringify({ ...summary, pdfPath: pdf?.path || null }, null, 2)}\n`);
    } finally {
      await unlink(nestedPath).catch(() => {});
    }
    return;
  }
  if (command === "version") {
    const version = (await readFile(new URL("./VERSION", import.meta.url), "utf8")).trim();
    process.stdout.write(
      `${JSON.stringify({
        tool: TOOL_NAME,
        version,
        input_schema: INPUT_SCHEMA,
        output_schema: OUTPUT_SCHEMA,
      }, null, 2)}\n`,
    );
    return;
  }
  if (command === "validate-input") {
    const input = validateInput(await readJson(argumentValue(rest, "--input"), "input"));
    process.stdout.write(
      `${JSON.stringify({ status: "valid", schema_version: input.schema_version }, null, 2)}\n`,
    );
    return;
  }
  if (command === "validate-output") {
    const output = validateOutput(await readJson(argumentValue(rest, "--output"), "output"));
    process.stdout.write(
      `${JSON.stringify({ status: "valid", schema_version: output.schema_version }, null, 2)}\n`,
    );
    return;
  }
  if (command === "capture") {
    const summary = await commandRun(
      argumentValue(rest, "--input"),
      argumentValue(rest, "--output"),
    );
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  throw new CliError("usage: clue-browser <version|validate-input|validate-output|capture> [options]");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
}
