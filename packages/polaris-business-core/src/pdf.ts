/**
 * Shared Chromium HTML → PDF rendering.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function findChrome(): string | null {
  for (const command of [
    "chromium-headless-shell",
    "google-chrome",
    "chromium",
    "chromium-browser",
  ]) {
    const result = spawnSync("which", [command], { encoding: "utf-8" });
    if (result.status === 0) return result.stdout.trim();
  }
  return null;
}

export function renderHtmlToPdf(inputHtmlPath: string, outputPdfPath: string): void {
  const chrome = findChrome();
  if (!chrome) {
    throw new Error("Chrome/Chromium not found on server.");
  }
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-pdf-"));
  const configDir = path.join(profileDir, "config");
  const cacheDir = path.join(profileDir, "cache");
  const runtimeDir = path.join(profileDir, "runtime");
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const args = [
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--disable-software-rasterizer",
    "--no-sandbox",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-extensions",
    "--disable-component-update",
    "--disable-breakpad",
    "--disable-crash-reporter",
    "--disable-features=UseDBus",
    `--user-data-dir=${profileDir}`,
    `--print-to-pdf=${outputPdfPath}`,
    pathToFileURL(inputHtmlPath).href,
  ];
  if (!path.basename(chrome).includes("headless-shell")) {
    args.unshift("--headless");
    args.push("--no-pdf-header-footer");
  }
  const result = spawnSync(chrome, args, {
    encoding: "utf-8",
    env: {
      ...process.env,
      HOME: profileDir,
      XDG_CONFIG_HOME: configDir,
      XDG_CACHE_HOME: cacheDir,
      XDG_RUNTIME_DIR: runtimeDir,
    },
  });
  fs.rmSync(profileDir, { recursive: true, force: true });
  if (result.status !== 0 || result.signal || !fs.existsSync(outputPdfPath)) {
    const details = [result.stderr, result.stdout].filter(Boolean).join("\n");
    const status = result.status === null ? "null" : String(result.status);
    const signal = result.signal ? ` signal ${result.signal}` : "";
    throw new Error(
      `PDF render failed with status ${status}${signal}${details ? `\n${details}` : ""}`,
    );
  }
}
