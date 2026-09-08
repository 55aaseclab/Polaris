/** clue-browser run backend powered by Camofox (Camoufox). */

import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { homedir } from "node:os";

import {
  CamofoxError,
  ensureCamofoxServer,
  parseNetscapeCookieFile,
} from "./camofox-client.mjs";

const CHALLENGE_MARKERS = [
  "just a moment",
  "checking your browser",
  "security check required",
  "cf-challenge",
  "enable javascript and cookies to continue",
  "verify you are human",
  "attention required",
];

function timestamp() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function artifactDir(outputPath) {
  const base = basename(outputPath, extname(outputPath));
  return resolve(dirname(outputPath), `${base}.artifacts`);
}

function artifactFile(outputPath, name, ext = "png") {
  return resolve(artifactDir(outputPath), `${name}.${ext}`);
}

async function fileDigest(path) {
  const content = await readFile(path);
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function looksLikeChallenge(title, snapshotText) {
  const hay = `${title || ""}\n${snapshotText || ""}`.toLowerCase();
  if (CHALLENGE_MARKERS.some((marker) => hay.includes(marker))) {
    return true;
  }
  // Cloudflare interstitial often keeps this exact title until cleared.
  if (/just a moment/i.test(title || "")) {
    return true;
  }
  return false;
}

function jsString(value) {
  return JSON.stringify(value ?? "");
}

async function extractText(client, tabId, selector, maxChars) {
  const limit = Number(maxChars) || 10_000;
  const expression = `(() => {
    const el = document.querySelector(${jsString(selector)});
    if (!el) return null;
    return (el.textContent || "").slice(0, ${limit});
  })()`;
  const result = await client.evaluate(tabId, expression);
  if (result?.result === null || result?.result === undefined) {
    throw new CamofoxError(`selector did not match: ${selector}`);
  }
  let text = String(result.result);
  // PDF.js / Firefox viewer: body text is chrome UI; accessibility snapshot has page text.
  if (
    selector === "body"
    && text.length < 400
    && /Manage pages|Zoom|Thumbnail of Page|of \d+/i.test(text)
  ) {
    const snap = await client.snapshot(tabId).catch(() => null);
    if (snap?.snapshot) {
      const lines = String(snap.snapshot)
        .split(/\n+/)
        .map((line) => {
          const match = line.match(/text:\s*\"(.*)\"\s*$/);
          if (match) {
            return match[1];
          }
          if (/region \"Page/i.test(line) || /Know Your|Abstract/.test(line)) {
            return line.replace(/^\s*-\s*/, "").trim();
          }
          return "";
        })
        .filter(Boolean);
      if (lines.length) {
        text = lines.join("\n").slice(0, limit);
      }
    }
  }
  return text;
}

async function extractAttribute(client, tabId, selector, attribute, maxChars) {
  const expression = `(() => {
    const el = document.querySelector(${jsString(selector)});
    if (!el) return null;
    const value = el.getAttribute(${jsString(attribute)});
    return value === null ? "" : String(value).slice(0, ${Number(maxChars) || 10000});
  })()`;
  const result = await client.evaluate(tabId, expression);
  if (result?.result === null) {
    throw new CamofoxError(`selector did not match: ${selector}`);
  }
  return String(result.result ?? "");
}

async function extractHtml(client, tabId, selector) {
  const expression = selector
    ? `(() => {
      const el = document.querySelector(${jsString(selector)});
      if (!el) return null;
      return el.outerHTML || "";
    })()`
    : `(() => {
      const root = document.documentElement;
      if (!root) return "";
      const doctype = document.doctype
        ? "<!DOCTYPE " + document.doctype.name + ">"
        : "<!DOCTYPE html>";
      return doctype + root.outerHTML;
    })()`;
  const result = await client.evaluate(tabId, expression);
  if (selector && (result?.result === null || result?.result === undefined)) {
    throw new CamofoxError(`selector did not match: ${selector}`);
  }
  return String(result?.result ?? "");
}

async function waitForChallengeClear(client, tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = { title: "", snapshot: "", url: "" };
  while (Date.now() < deadline) {
    let title = "";
    try {
      const titleEval = await client.evaluate(tabId, "document.title");
      title = titleEval?.result != null ? String(titleEval.result) : "";
    } catch {
      // ignore
    }
    const snap = await client.snapshot(tabId).catch(() => null);
    if (snap || title) {
      last = {
        title: title || snap?.title || "",
        snapshot: snap?.snapshot || "",
        url: snap?.url || "",
      };
      if (!looksLikeChallenge(last.title, last.snapshot)) {
        // confirm stable (title must not flip back to CF interstitial)
        await delay(800);
        let title2 = last.title;
        try {
          const againTitle = await client.evaluate(tabId, "document.title");
          title2 = againTitle?.result != null ? String(againTitle.result) : last.title;
        } catch {
          // ignore
        }
        const again = await client.snapshot(tabId).catch(() => null);
        if (
          !looksLikeChallenge(title2, again?.snapshot || "")
          && !/just a moment/i.test(title2)
        ) {
          return {
            cleared: true,
            ...last,
            title: title2,
            url: again?.url || last.url,
            snapshot: again?.snapshot || last.snapshot,
          };
        }
      }
    }
    await delay(1_200);
  }
  return { cleared: !looksLikeChallenge(last.title, last.snapshot), ...last };
}

async function saveDownloads(client, tabId, outputPath, artifacts) {
  const payload = await client.downloads(tabId, { includeData: true }).catch(() => null);
  const downloads = payload?.downloads || [];
  for (const item of downloads) {
    const name = (item.filename || item.suggestedFilename || `download-${artifacts.length}.bin`)
      .replace(/[^A-Za-z0-9._-]+/g, "_");
    const target = resolve(artifactDir(outputPath), name);
    await mkdir(dirname(target), { recursive: true });
    if (item.data || item.base64) {
      let data = item.data || item.base64;
      if (typeof data === "string" && data.startsWith("data:")) {
        data = data.split(",", 2)[1];
      }
      await writeFile(target, Buffer.from(data, "base64"));
    } else if (item.path) {
      const content = await readFile(item.path);
      await writeFile(target, content);
    } else {
      continue;
    }
    artifacts.push({
      kind: "download",
      path: target,
      filename: name,
      sha256: await fileDigest(target),
      bytes: (await stat(target)).size,
    });
  }
}

/**
 * Firefox PDF.js viewer keeps the PDF in memory (contentType application/pdf)
 * without firing a Playwright download event. Export via PDFViewerApplication.
 */
async function saveInlinePdfViewer(client, tabId, outputPath, artifacts, pageUrl = "") {
  // Skip if we already have a PDF artifact.
  if (artifacts.some((item) => item.kind === "download" && /\.pdf$/i.test(item.filename || item.path || ""))) {
    return null;
  }
  const expression = `(async () => {
    try {
      const app = window.PDFViewerApplication;
      if (!app || !app.pdfDocument) {
        return { ok: false, reason: !app ? "no-pdfjs" : "no-document" };
      }
      const data = await app.pdfDocument.getData();
      const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
      if (!(u8[0] === 0x25 && u8[1] === 0x50 && u8[2] === 0x44 && u8[3] === 0x46)) {
        return { ok: false, reason: "not-pdf-magic", len: u8.length };
      }
      let binary = "";
      const chunk = 0x8000;
      for (let i = 0; i < u8.length; i += chunk) {
        binary += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
      }
      const title = (document.title || "document").replace(/[^A-Za-z0-9._-]+/g, "_");
      const filename = title.toLowerCase().endsWith(".pdf") ? title : title + ".pdf";
      return { ok: true, len: u8.length, filename, b64: btoa(binary) };
    } catch (error) {
      return { ok: false, reason: String(error && error.message || error) };
    }
  })()`;
  const out = await client.evaluate(tabId, expression).catch(() => null);
  const result = out?.result;
  if (!result?.ok || !result.b64) {
    return result || null;
  }
  const filename = (result.filename || "document.pdf").replace(/[^A-Za-z0-9._-]+/g, "_");
  const target = resolve(artifactDir(outputPath), filename);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, Buffer.from(result.b64, "base64"));
  const info = {
    kind: "download",
    path: target,
    filename,
    content_type: "application/pdf",
    source: "pdfjs-viewer",
    url: pageUrl || undefined,
    sha256: await fileDigest(target),
    bytes: (await stat(target)).size,
  };
  artifacts.push(info);
  return info;
}

/**
 * @param {object} args
 * @param {object} args.input validated input document
 * @param {string} args.outputPath
 * @param {object} args.policy resolveBrowserPolicy result
 * @param {string} args.toolVersion
 * @param {function} args.validateOutput
 */
function resolveSessionUserId(input, policy) {
  const raw =
    policy.sessionUserId
    || process.env.BROWSER_CAMOFOX_USER_ID
    || `clue-${input.run_id}`;
  return String(raw).replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64) || "clue-browser";
}

function resolveImportCookiesPath(policy) {
  const raw = policy.importCookiesPath || process.env.BROWSER_IMPORT_COOKIES_PATH || "";
  if (!raw || !String(raw).trim()) {
    return null;
  }
  const value = String(raw).trim();
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) {
    return resolve(value);
  }
  const cookiesDir =
    process.env.CAMOFOX_COOKIES_DIR
    || resolve(homedir(), ".camofox", "cookies");
  return resolve(cookiesDir, value);
}

async function importCookiesIfConfigured(client, policy, actions) {
  const cookiesPath = resolveImportCookiesPath(policy);
  if (!cookiesPath) {
    return { imported: 0, path: null };
  }
  let text;
  try {
    text = await readFile(cookiesPath, "utf8");
  } catch (error) {
    actions.push({
      index: actions.length + 1,
      type: "import-cookies",
      status: "skipped",
      reason: `cookie file unreadable: ${error instanceof Error ? error.message : String(error)}`,
      path: cookiesPath,
    });
    return { imported: 0, path: cookiesPath };
  }
  const cookies = parseNetscapeCookieFile(text);
  if (!cookies.length) {
    actions.push({
      index: actions.length + 1,
      type: "import-cookies",
      status: "skipped",
      reason: "cookie file contained no Netscape cookies",
      path: cookiesPath,
    });
    return { imported: 0, path: cookiesPath };
  }
  const result = await client.importCookies(cookies);
  actions.push({
    index: actions.length + 1,
    type: "import-cookies",
    status: "succeeded",
    path: cookiesPath,
    count: result?.count ?? cookies.length,
  });
  return { imported: result?.count ?? cookies.length, path: cookiesPath };
}

export async function commandRunCamofox({
  input,
  outputPath,
  policy,
  toolVersion,
  validateOutput,
  TOOL_NAME,
  OUTPUT_SCHEMA,
}) {
  const startedAt = timestamp();
  // Stable session_user_id reuses Camofox persistence (~/.camofox/profiles) so
  // imported Google/Scholar cookies survive across runs. Random run_id alone
  // creates a cold anonymous profile every time.
  const userId = resolveSessionUserId(input, policy);
  const { client, stop, started } = await ensureCamofoxServer({
    proxy: policy.proxy,
    userId,
    baseUrl: policy.camofoxUrl,
  });

  const artifacts = [];
  const extractions = [];
  const actions = [];
  let tabId = null;
  let challengeOnStart = "absent or cleared";
  let cookieImport = { imported: 0, path: null };

  try {
    const created = await client.createTab(input.start_url, { sessionKey: input.run_id });
    tabId = created.tabId || created.id;
    if (!tabId) {
      throw new CamofoxError("camofox create tab did not return tabId");
    }

    // Import Netscape cookies after the session exists (Camofox docs:
    // POST /sessions/:userId/cookies). Persistence plugin also auto-loads
    // ~/.camofox/cookies/cookies.txt on first run for this userId.
    cookieImport = await importCookiesIfConfigured(client, policy, actions);

    // Allow CF / first paint
    await delay(policy.humanize ? 1_500 : 600);
    if (policy.waitForChallenge) {
      const outcome = await waitForChallengeClear(client, tabId, policy.challengeTimeoutMs);
      challengeOnStart = outcome.cleared ? "absent or cleared" : "still present after wait";
    }

    await saveDownloads(client, tabId, outputPath, artifacts);
    {
      const snap0 = await client.snapshot(tabId).catch(() => ({}));
      await saveInlinePdfViewer(client, tabId, outputPath, artifacts, snap0.url || input.start_url);
    }

    for (let offset = 0; offset < input.actions.length; offset += 1) {
      const action = input.actions[offset];
      const index = offset + 1;
      const result = { index, type: action.type, status: "succeeded" };
      const actionTimeout = action.timeout_ms || policy.timeoutMs;

      if (action.type === "goto") {
        await client.navigate(tabId, action.url);
        if (policy.waitForChallenge) {
          await waitForChallengeClear(client, tabId, Math.min(actionTimeout, policy.challengeTimeoutMs));
        }
        await saveDownloads(client, tabId, outputPath, artifacts);
        const afterGoto = await client.snapshot(tabId).catch(() => ({}));
        await saveInlinePdfViewer(client, tabId, outputPath, artifacts, afterGoto.url || action.url);
      } else if (action.type === "screenshot") {
        const name = action.name || `action-${String(index).padStart(3, "0")}`;
        const path = artifactFile(outputPath, name, "png");
        await mkdir(dirname(path), { recursive: true });
        const buffer = await client.screenshot(tabId, { fullPage: action.full_page ?? true });
        await writeFile(path, buffer);
        artifacts.push({
          kind: "screenshot",
          path,
          sha256: await fileDigest(path),
          bytes: (await stat(path)).size,
        });
        result.artifact_path = path;
      } else if (action.type === "scroll") {
        const times = action.times ?? 1;
        for (let i = 0; i < Math.max(1, times); i += 1) {
          await client.scroll(tabId, {
            direction: (action.delta_y ?? 400) >= 0 ? "down" : "up",
            amount: Math.abs(action.delta_y ?? 400),
          });
          await delay(200);
        }
      } else if (action.type === "solve-challenge") {
        const outcome = await waitForChallengeClear(
          client,
          tabId,
          action.timeout_ms || policy.challengeTimeoutMs,
        );
        result.challenge = {
          detected: looksLikeChallenge(outcome.title, outcome.snapshot) || !outcome.cleared,
          cleared: outcome.cleared,
          clicks: [],
        };
        if (!outcome.cleared) {
          result.status = "unresolved";
        }
      } else if (action.type === "wait-for") {
        const deadline = Date.now() + actionTimeout;
        let found = false;
        while (Date.now() < deadline) {
          const expression = `!!document.querySelector(${jsString(action.selector)})`;
          const out = await client.evaluate(tabId, expression).catch(() => null);
          if (out?.result) {
            found = true;
            break;
          }
          await delay(250);
        }
        if (!found) {
          throw new CamofoxError(`wait-for timed out for selector: ${action.selector}`);
        }
      } else if (action.type === "click" || action.type === "check") {
        try {
          // Prefer first match; for SSRN prefer "Open PDF in Browser" (type=2) which
          // loads PDF.js (exportable) over bare Delivery.cfm attachment downloads.
          const clickExpr = `(() => {
            const selector = ${jsString(action.selector)};
            const nodes = [...document.querySelectorAll(selector)];
            if (!nodes.length) return { ok: false, reason: "not-found" };
            let el = nodes[0];
            const openInBrowser = nodes.find((n) => {
              const href = n.getAttribute("href") || "";
              const text = (n.innerText || n.textContent || "").toLowerCase();
              return /type=2/i.test(href) || /open pdf in browser/i.test(text);
            });
            if (openInBrowser) el = openInBrowser;
            const href = el.getAttribute("href") || el.href || "";
            el.click();
            return { ok: true, href, text: (el.innerText || "").trim().slice(0, 80) };
          })()`;
          const clicked = await client.evaluate(tabId, clickExpr).catch(() => null);
          if (!clicked?.result?.ok) {
            await client.click(tabId, { selector: action.selector });
          } else {
            result.href = clicked.result.href || undefined;
            result.clicked_text = clicked.result.text || undefined;
          }
          // Wait for either a download event or PDF.js inline viewer.
          for (let wait = 0; wait < 16; wait += 1) {
            await delay(500);
            await saveDownloads(client, tabId, outputPath, artifacts);
            const afterClick = await client.snapshot(tabId).catch(() => ({}));
            await saveInlinePdfViewer(
              client,
              tabId,
              outputPath,
              artifacts,
              afterClick.url || input.start_url,
            );
            if (artifacts.some((item) => item.kind === "download")) {
              break;
            }
          }
        } catch (error) {
          // Soft-fail: publisher download buttons are optional (e.g. SSRN Delivery.cfm).
          result.status = "skipped";
          result.reason = error instanceof Error ? error.message : String(error);
        }
      } else if (action.type === "fill") {
        await client.type(tabId, { selector: action.selector, text: action.value });
      } else if (action.type === "press") {
        // Focus via click if selector present, then press
        if (action.selector) {
          await client.click(tabId, { selector: action.selector }).catch(() => null);
        }
        await client.press(tabId, action.key);
      } else if (action.type === "select") {
        const expression = `(() => {
          const el = document.querySelector(${jsString(action.selector)});
          if (!el) return false;
          el.value = ${jsString(action.value)};
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        })()`;
        const out = await client.evaluate(tabId, expression);
        if (!out?.result) {
          throw new CamofoxError(`select failed for selector: ${action.selector}`);
        }
      } else if (action.type === "extract-text") {
        try {
          const value = await extractText(
            client,
            tabId,
            action.selector,
            action.max_chars,
          );
          extractions.push({
            name: action.name ?? `extraction-${index}`,
            kind: "text",
            value,
          });
        } catch (error) {
          result.status = "skipped";
          result.reason = error instanceof Error ? error.message : String(error);
        }
      } else if (action.type === "extract-attribute") {
        try {
          const value = await extractAttribute(
            client,
            tabId,
            action.selector,
            action.attribute,
            action.max_chars,
          );
          extractions.push({
            name: action.name ?? `extraction-${index}`,
            kind: "attribute",
            attribute: action.attribute,
            value,
          });
        } catch (error) {
          result.status = "skipped";
          result.reason = error instanceof Error ? error.message : String(error);
        }
      } else if (action.type === "extract-html") {
        try {
          const html = await extractHtml(client, tabId, action.selector);
          const name = action.name || `html-${index}`;
          const path = artifactFile(outputPath, name, "html");
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, html, "utf8");
          const limit = Number(action.max_chars) || 500_000;
          artifacts.push({
            kind: "html",
            path,
            sha256: await fileDigest(path),
            bytes: (await stat(path)).size,
          });
          extractions.push({
            name,
            kind: "html",
            value: html.slice(0, Math.max(1, limit)),
            path,
          });
          result.artifact_path = path;
        } catch (error) {
          result.status = "skipped";
          result.reason = error instanceof Error ? error.message : String(error);
        }
      } else {
        throw new CamofoxError(`unsupported action type on camofox backend: ${action.type}`);
      }

      const snap = await client.snapshot(tabId).catch(() => null);
      result.url = snap?.url || input.start_url;
      actions.push(result);

      if (offset + 1 < input.actions.length && policy.humanize) {
        await delay(policy.minDelayMs + Math.random() * Math.max(0, policy.maxDelayMs - policy.minDelayMs));
      }
    }

    // If no PDF yet, click SSRN "Open PDF in Browser" (Delivery.cfm&type=2) in-session.
    if (artifacts.every((item) => item.kind !== "download")) {
      try {
        const clickDl = await client.evaluate(tabId, `(() => {
          const nodes = [...document.querySelectorAll("a[href]")];
          const scored = nodes
            .map((a) => {
              const href = a.getAttribute("href") || "";
              const text = (a.innerText || a.textContent || "").toLowerCase();
              let score = 99;
              if (/delivery\\.cfm/i.test(href) && /type=2/i.test(href)) score = 0;
              else if (/open pdf in browser/i.test(text)) score = 1;
              else if (/delivery\\.cfm/i.test(href) && /\\.pdf/i.test(href)) score = 2;
              else if (/\\.pdf(\\?|$)/i.test(href)) score = 3;
              return { a, href, text, score };
            })
            .filter((x) => x.score < 99)
            .sort((x, y) => x.score - y.score);
          if (!scored.length) return { ok: false };
          const best = scored[0];
          best.a.click();
          return { ok: true, href: best.a.href || best.href, score: best.score, text: best.text.slice(0, 80) };
        })()`).catch(() => null);
        if (clickDl?.result?.ok) {
          for (let wait = 0; wait < 20; wait += 1) {
            await delay(500);
            await saveDownloads(client, tabId, outputPath, artifacts);
            const after = await client.snapshot(tabId).catch(() => ({}));
            await saveInlinePdfViewer(
              client,
              tabId,
              outputPath,
              artifacts,
              after.url || input.start_url,
            );
            if (artifacts.some((item) => item.kind === "download")) {
              break;
            }
          }
          actions.push({
            index: actions.length + 1,
            type: "click",
            status: artifacts.some((item) => item.kind === "download") ? "succeeded" : "unresolved",
            href: clickDl.result.href,
            reason: "publisher-pdf-open-in-browser",
          });
        }
      } catch {
        // optional
      }
    }

    await saveDownloads(client, tabId, outputPath, artifacts);
    {
      const beforeFinal = await client.snapshot(tabId).catch(() => ({}));
      await saveInlinePdfViewer(client, tabId, outputPath, artifacts, beforeFinal.url || input.start_url);
    }

    const finalSnap = await client.snapshot(tabId).catch(() => ({}));
    let finalUrl = finalSnap.url || input.start_url;
    if (!/^https?:\/\//i.test(finalUrl)) {
      finalUrl = input.start_url;
    }
    let pageTitle = finalSnap.title || "";
    if (!pageTitle) {
      const titleEval = await client.evaluate(tabId, "document.title").catch(() => null);
      pageTitle = titleEval?.result != null ? String(titleEval.result) : "";
    }
    const output = {
      schema_version: OUTPUT_SCHEMA,
      tool: { name: TOOL_NAME, version: toolVersion },
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
        backend: "camofox",
        camofox: started ? "started local server for this run" : "reused existing server",
        session_user_id: userId,
        cookie_import: cookieImport.path
          ? { path: cookieImport.path, imported: cookieImport.imported }
          : null,
        stealth: "Camoufox C++ anti-detection (via camofox-browser)",
        humanize: policy.humanize ? "inter-action delays" : "disabled",
        pacing: policy.humanize
          ? `random delay ${policy.minDelayMs}-${policy.maxDelayMs} ms`
          : "none",
        proxy: policy.proxy?.server ?? null,
        wait_for_challenge: policy.waitForChallenge
          ? `poll up to ${policy.challengeTimeoutMs} ms`
          : "disabled",
        challenge_click: "delegated to Camoufox engine (no ad-hoc Turnstile clicks)",
        challenge_on_start: challengeOnStart,
        locale: policy.locale,
        timezone_id: policy.timezoneId,
        viewport: policy.viewport,
        channel: "camoufox",
        downloads: "camofox download events + PDF.js inline viewer export",
      },
    };
    validateOutput(output);
    await mkdir(dirname(resolve(outputPath)), { recursive: true });
    await writeFile(resolve(outputPath), `${JSON.stringify(output, null, 2)}\n`, "utf8");
    return {
      status: "succeeded",
      output: resolve(outputPath),
      action_count: actions.length,
      download_count: artifacts.filter((item) => item.kind === "download").length,
      backend: "camofox",
    };
  } finally {
    if (tabId) {
      await client.closeTab(tabId);
    }
    await client.closeSession();
    await stop();
  }
}
