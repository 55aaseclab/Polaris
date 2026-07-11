import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "../utils/paths.js";

let cachedVersion: string | null = null;

function parseVersionDoc(content: string): string | null {
  const match = /Release version:\s*`([^`]+)`/u.exec(content);
  return match?.[1]?.trim() || null;
}

export function resolvePolarisAppVersion(importMetaUrl: string): string {
  if (cachedVersion) {
    return cachedVersion;
  }
  const configured = process.env.POLARIS_APP_VERSION?.trim();
  if (configured) {
    cachedVersion = configured;
    return configured;
  }
  try {
    const root = repoRoot(importMetaUrl);
    const versionDoc = path.join(root, "apps", "docs", "site", "0.2.7", "VERSION.md");
    if (fs.existsSync(versionDoc)) {
      const parsed = parseVersionDoc(fs.readFileSync(versionDoc, "utf8"));
      if (parsed) {
        cachedVersion = parsed;
        return parsed;
      }
    }
  } catch {
    // Ignore and fall through to the fallback.
  }
  cachedVersion = "unknown";
  return cachedVersion;
}
