#!/usr/bin/env node
/**
 * Built-in challenge snapshot parser for clue-browser.
 *
 * Imported by runner.mjs. Also usable as a CLI:
 *   node challenge-vision-helper.mjs /path/to/challenge-00.png
 *
 * Strategy:
 * 1. Prefer sibling *.layout.json geometry (Turnstile checkbox is left-aligned).
 * 2. Optional vision model if BROWSER_CHALLENGE_VISION_API_KEY or OPENAI_API_KEY.
 * 3. Fallback viewport heuristic.
 */

import { access, readFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function layoutPathFor(shotPath) {
  const dir = dirname(shotPath);
  const base = basename(shotPath, extname(shotPath));
  return join(dir, `${base}.layout.json`);
}

export function pointsFromLayout(layout) {
  const nodes = Array.isArray(layout?.nodes) ? layout.nodes : [];
  const points = [];

  const iframe = nodes.find(
    (n) =>
      String(n.tag || "").toUpperCase() === "IFRAME"
      && /turnstile|challenges\.cloudflare|challenge-platform/i.test(
        `${n.src || ""} ${n.title || ""}`,
      ),
  ) || nodes.find(
    (n) => String(n.tag || "").toUpperCase() === "IFRAME" && n.width >= 40 && n.height >= 20,
  );

  const turnstile = nodes.find(
    (n) => n.selector === ".cf-turnstile" || /cf-turnstile/i.test(n.className || ""),
  );

  const captcha = nodes.find(
    (n) => n.selector === ".challenge-captcha" || /challenge-captcha/i.test(n.className || ""),
  );

  const leftBand = (box, label, opts = {}) => {
    const {
      leftRatio = 0.1,
      leftPx = 28,
      yRatio = 0.5,
    } = opts;
    const x = box.x + Math.min(leftPx, Math.max(16, box.width * leftRatio));
    const y = box.y + box.height * yRatio;
    points.push({ x: Math.round(x), y: Math.round(y), label });
  };

  if (iframe) {
    leftBand(iframe, "iframe-checkbox", { leftPx: 30, leftRatio: 0.12 });
    points.push({
      x: Math.round(iframe.x + Math.min(88, iframe.width * 0.28)),
      y: Math.round(iframe.y + iframe.height * 0.5),
      label: "iframe-label",
    });
  }

  if (turnstile) {
    leftBand(turnstile, "turnstile-checkbox", { leftPx: 30 });
  }

  if (captcha) {
    const widgetW = Math.min(300, captcha.width * 0.9);
    const widgetH = Math.min(65, captcha.height);
    const widgetX = captcha.x + (captcha.width - widgetW) / 2;
    const widgetY = captcha.y + (captcha.height - widgetH) / 2;
    leftBand(
      { x: widgetX, y: widgetY, width: widgetW, height: widgetH },
      "captcha-centered-widget-checkbox",
      { leftPx: 32, leftRatio: 0.1 },
    );
    leftBand(captcha, "captcha-band-left", { leftPx: 28, leftRatio: 0.05 });
  }

  const seen = new Set();
  return points.filter((p) => {
    const key = `${p.x},${p.y}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return Number.isFinite(p.x) && Number.isFinite(p.y);
  });
}

export async function pointsFromVisionModel(shotPath) {
  const apiKey = (
    process.env.BROWSER_CHALLENGE_VISION_API_KEY
    || process.env.OPENAI_API_KEY
    || ""
  ).trim();
  if (!apiKey) {
    return null;
  }

  const baseUrl = (
    process.env.BROWSER_CHALLENGE_VISION_BASE_URL
    || process.env.OPENAI_BASE_URL
    || "https://api.openai.com/v1"
  ).replace(/\/$/, "");
  const model = (
    process.env.BROWSER_CHALLENGE_VISION_MODEL
    || process.env.OPENAI_VISION_MODEL
    || "gpt-4o-mini"
  );

  const bytes = await readFile(shotPath);
  const b64 = bytes.toString("base64");
  const mime = shotPath.toLowerCase().endsWith(".jpg") || shotPath.toLowerCase().endsWith(".jpeg")
    ? "image/jpeg"
    : "image/png";

  const body = {
    model,
    temperature: 0,
    max_tokens: 200,
    messages: [
      {
        role: "system",
        content:
          "You locate Cloudflare Turnstile / captcha checkboxes in screenshots. "
          + "Return ONLY JSON: {\"x\":number,\"y\":number} with viewport pixel coordinates "
          + "for the checkbox center. If multiple, pick the primary interactive checkbox. "
          + "If none, return {\"x\":null,\"y\":null}.",
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text:
              "Find the Turnstile checkbox (left square of the verify widget). "
              + "Coordinates are CSS pixels from the top-left of the screenshot.",
          },
          {
            type: "image_url",
            image_url: { url: `data:${mime};base64,${b64}` },
          },
        ],
      },
    ],
  };

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    return null;
  }

  const json = await response.json();
  const content = json?.choices?.[0]?.message?.content || "";
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end === -1) {
    return null;
  }
  const parsed = JSON.parse(content.slice(start, end + 1));
  if (parsed.x == null || parsed.y == null) {
    return null;
  }
  if (!Number.isFinite(Number(parsed.x)) || !Number.isFinite(Number(parsed.y))) {
    return null;
  }
  return [{
    x: Math.round(Number(parsed.x)),
    y: Math.round(Number(parsed.y)),
    label: "vision-model",
  }];
}

/**
 * Resolve click points for a challenge screenshot path.
 * Used by runner.mjs (built-in) and the CLI entrypoint.
 */
export async function resolveChallengeClickPoints(shotPath, layout = null) {
  // 1) In-memory layout (preferred when runner already captured it).
  if (layout) {
    const points = pointsFromLayout(layout);
    if (points.length) {
      return { points, source: "layout" };
    }
  }

  // 2) Sibling layout.json
  const layoutFile = layoutPathFor(shotPath);
  try {
    await access(layoutFile);
    const parsed = JSON.parse(await readFile(layoutFile, "utf8"));
    const points = pointsFromLayout(parsed);
    if (points.length) {
      return { points, source: "layout", layout: layoutFile };
    }
  } catch {
    // ignore missing/invalid layout
  }

  // 3) Optional vision model
  try {
    const visionPoints = await pointsFromVisionModel(shotPath);
    if (visionPoints?.length) {
      return { points: visionPoints, source: "vision-model" };
    }
  } catch {
    // ignore
  }

  // 4) Fallback
  return {
    points: [{ x: 640, y: 545, label: "fallback-center" }],
    source: "fallback",
  };
}

async function main(argv) {
  const shotPath = argv[0];
  if (!shotPath) {
    process.stderr.write("usage: challenge-vision-helper.mjs <screenshot.png>\n");
    process.exit(2);
  }
  const result = await resolveChallengeClickPoints(shotPath);
  const first = result.points[0];
  process.stdout.write(`${JSON.stringify({
    x: first.x,
    y: first.y,
    points: result.points,
    source: result.source,
    layout: result.layout,
  })}\n`);
}

const isCli = process.argv[1]
  && fileURLToPath(import.meta.url) === process.argv[1];

if (isCli) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `challenge-vision-helper: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(2);
  });
}
