/** Thin HTTP client for @askjo/camofox-browser REST API. */

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));

export class CamofoxError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = "CamofoxError";
    this.status = status;
    this.body = body;
  }
}

function defaultBaseUrl() {
  const port = process.env.CAMOFOX_PORT || process.env.BROWSER_CAMOFOX_PORT || "9377";
  const host = process.env.BROWSER_CAMOFOX_HOST || "127.0.0.1";
  return process.env.BROWSER_CAMOFOX_URL || `http://${host}:${port}`;
}

export function proxyEnvFromBrowserProxy(proxy) {
  if (!proxy?.server) {
    return {};
  }
  try {
    const url = new URL(proxy.server.includes("://") ? proxy.server : `http://${proxy.server}`);
    return {
      PROXY_HOST: url.hostname,
      PROXY_PORT: url.port || (url.protocol === "https:" ? "443" : "80"),
      PROXY_USERNAME: proxy.username || process.env.BROWSER_PROXY_USERNAME || "",
      PROXY_PASSWORD: proxy.password || process.env.BROWSER_PROXY_PASSWORD || "",
    };
  } catch {
    return {};
  }
}

export class CamofoxClient {
  constructor({ baseUrl, userId, accessKey } = {}) {
    this.baseUrl = (baseUrl || defaultBaseUrl()).replace(/\/$/, "");
    this.userId = userId || `clue-${process.pid}`;
    // Cookie import prefers CAMOFOX_API_KEY; general routes may use ACCESS_KEY.
    this.accessKey =
      accessKey
      || process.env.CAMOFOX_API_KEY
      || process.env.CAMOFOX_ACCESS_KEY
      || process.env.BROWSER_CAMOFOX_ACCESS_KEY
      || "";
  }

  headers(json = true) {
    const headers = {};
    if (json) {
      headers["content-type"] = "application/json";
    }
    if (this.accessKey) {
      headers.authorization = `Bearer ${this.accessKey}`;
    }
    return headers;
  }

  async request(method, path, { query, body, raw } = {}) {
    const url = new URL(path, `${this.baseUrl}/`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      }
    }
    const response = await fetch(url, {
      method,
      headers: this.headers(!raw && body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (raw) {
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new CamofoxError(`camofox ${method} ${path} failed: HTTP ${response.status}`, {
          status: response.status,
          body: text,
        });
      }
      return response;
    }
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    if (!response.ok) {
      throw new CamofoxError(
        data?.error || `camofox ${method} ${path} failed: HTTP ${response.status}`,
        { status: response.status, body: data },
      );
    }
    return data;
  }

  async health() {
    const data = await this.request("GET", "/health");
    // Server may answer HTTP 200 with ok:false while browser is down, or HTTP 503.
    if (data && data.ok === false) {
      throw new CamofoxError(data.reason || "camofox health ok=false", { body: data });
    }
    return data;
  }

  createTab(url, { sessionKey = "clue" } = {}) {
    return this.request("POST", "/tabs", {
      body: { userId: this.userId, sessionKey, url },
    });
  }

  navigate(tabId, url) {
    return this.request("POST", `/tabs/${tabId}/navigate`, {
      body: { userId: this.userId, url },
    });
  }

  snapshot(tabId, { includeScreenshot = false } = {}) {
    return this.request("GET", `/tabs/${tabId}/snapshot`, {
      query: {
        userId: this.userId,
        includeScreenshot: includeScreenshot ? "true" : undefined,
      },
    });
  }

  async screenshot(tabId, { fullPage = true } = {}) {
    const response = await this.request("GET", `/tabs/${tabId}/screenshot`, {
      query: {
        userId: this.userId,
        fullPage: fullPage ? "true" : "false",
      },
      raw: true,
    });
    return Buffer.from(await response.arrayBuffer());
  }

  click(tabId, { selector, ref } = {}) {
    return this.request("POST", `/tabs/${tabId}/click`, {
      body: { userId: this.userId, selector, ref },
    });
  }

  type(tabId, { selector, ref, text, pressEnter = false } = {}) {
    return this.request("POST", `/tabs/${tabId}/type`, {
      body: {
        userId: this.userId,
        selector,
        ref,
        text,
        pressEnter,
      },
    });
  }

  press(tabId, key) {
    return this.request("POST", `/tabs/${tabId}/press`, {
      body: { userId: this.userId, key },
    });
  }

  scroll(tabId, { direction = "down", amount } = {}) {
    return this.request("POST", `/tabs/${tabId}/scroll`, {
      body: { userId: this.userId, direction, amount },
    });
  }

  wait(tabId, { selector, timeoutMs } = {}) {
    return this.request("POST", `/tabs/${tabId}/wait`, {
      body: {
        userId: this.userId,
        selector,
        timeout: timeoutMs,
      },
    });
  }

  evaluate(tabId, expression) {
    return this.request("POST", `/tabs/${tabId}/evaluate`, {
      body: { userId: this.userId, expression },
    });
  }

  downloads(tabId, { includeData = true } = {}) {
    return this.request("GET", `/tabs/${tabId}/downloads`, {
      query: {
        userId: this.userId,
        includeData: includeData ? "true" : undefined,
      },
    });
  }

  closeTab(tabId) {
    return this.request("DELETE", `/tabs/${tabId}`, {
      query: { userId: this.userId },
    }).catch(() => null);
  }

  closeSession() {
    return this.request("DELETE", `/sessions/${this.userId}`).catch(() => null);
  }

  /**
   * Import Playwright-format cookies into this user session.
   * See camofox POST /sessions/:userId/cookies (CAMOFOX_API_KEY or loopback).
   */
  importCookies(cookies) {
    return this.request("POST", `/sessions/${this.userId}/cookies`, {
      body: { cookies },
    });
  }
}

/**
 * Parse a Netscape cookies.txt file into Playwright cookie objects.
 * Supports #HttpOnly_ lines used by browser export extensions.
 */
export function parseNetscapeCookieFile(text) {
  const cookies = [];
  const cleaned = String(text || "").replace(/^\uFEFF/, "");
  for (const rawLine of cleaned.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#") && !line.startsWith("#HttpOnly_")) continue;
    let httpOnly = false;
    let working = line;
    if (working.startsWith("#HttpOnly_")) {
      httpOnly = true;
      working = working.replace(/^#HttpOnly_/, "");
    }
    const parts = working.split("\t");
    if (parts.length < 7) continue;
    const domain = parts[0];
    const cookiePath = parts[2] || "/";
    const secure = String(parts[3] || "").toUpperCase() === "TRUE";
    const expires = Number(parts[4]);
    const name = parts[5];
    const value = parts.slice(6).join("\t");
    if (!name || !domain) continue;
    cookies.push({
      name,
      value,
      domain,
      path: cookiePath,
      expires: Number.isFinite(expires) ? expires : -1,
      httpOnly,
      secure,
    });
  }
  return cookies;
}

async function findServerEntry() {
  const candidates = [
    join(HERE, "node_modules/@askjo/camofox-browser/server.js"),
  ];
  for (const path of candidates) {
    try {
      await access(path);
      return path;
    } catch {
      // continue
    }
  }
  try {
    return require.resolve("@askjo/camofox-browser/server.js", { paths: [HERE] });
  } catch {
    try {
      return require.resolve("@askjo/camofox-browser/server.js");
    } catch {
      return null;
    }
  }
}

/**
 * Ensure a Camofox server is reachable. Starts a local one if needed.
 * Returns { client, stop } where stop() kills a process we started.
 */
export async function ensureCamofoxServer({
  baseUrl,
  proxy,
  userId,
  startupTimeoutMs = 90_000,
} = {}) {
  const client = new CamofoxClient({ baseUrl, userId });
  try {
    await client.health();
    return { client, stop: async () => {}, started: false };
  } catch {
    // start local server
  }

  const entry = await findServerEntry();
  if (!entry) {
    throw new CamofoxError(
      "Camofox server not running and @askjo/camofox-browser is not installed; run clue-browser setup",
    );
  }

  const proxyEnv = proxyEnvFromBrowserProxy(proxy);
  // Also accept BROWSER_PROXY_* when proxy object missing fields
  if (!proxyEnv.PROXY_HOST && process.env.BROWSER_PROXY_SERVER) {
    Object.assign(proxyEnv, proxyEnvFromBrowserProxy({
      server: process.env.BROWSER_PROXY_SERVER,
      username: process.env.BROWSER_PROXY_USERNAME,
      password: process.env.BROWSER_PROXY_PASSWORD,
    }));
  }

  const port = process.env.CAMOFOX_PORT || process.env.BROWSER_CAMOFOX_PORT || "9377";
  const child = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      ...proxyEnv,
      CAMOFOX_PORT: String(port),
      CAMOFOX_CRASH_REPORT_ENABLED: process.env.CAMOFOX_CRASH_REPORT_ENABLED || "false",
      // Prefer virtual display when no usable DISPLAY
      DISPLAY: process.env.DISPLAY || undefined,
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  let logs = "";
  child.stdout?.on("data", (chunk) => {
    logs += chunk.toString();
    if (logs.length > 8_000) {
      logs = logs.slice(-8_000);
    }
  });
  child.stderr?.on("data", (chunk) => {
    logs += chunk.toString();
    if (logs.length > 8_000) {
      logs = logs.slice(-8_000);
    }
  });

  const startedClient = new CamofoxClient({
    baseUrl: baseUrl || `http://127.0.0.1:${port}`,
    userId,
  });
  const deadline = Date.now() + startupTimeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new CamofoxError(
        `Camofox server exited during startup (code ${child.exitCode}): ${logs.slice(-500)}`,
      );
    }
    try {
      await startedClient.health();
      return {
        client: startedClient,
        started: true,
        stop: async () => {
          if (child.exitCode === null) {
            child.kill("SIGTERM");
            await delay(500);
            if (child.exitCode === null) {
              child.kill("SIGKILL");
            }
          }
        },
      };
    } catch (error) {
      lastError = error;
      await delay(400);
    }
  }
  child.kill("SIGKILL");
  throw new CamofoxError(
    `Camofox server did not become healthy within ${startupTimeoutMs}ms: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }\n${logs.slice(-800)}`,
  );
}
