import fs from "node:fs";
import path from "node:path";

function parseSemver(raw) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(raw.trim());
  if (!match) {
    return null;
  }
  return match.slice(1).map((value) => Number.parseInt(value, 10));
}

function compareSemver(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }
  return 0;
}

export function resolveCurrentReleaseVersion(rootDir = process.cwd()) {
  const versionDoc = path.join(rootDir, "apps", "docs", "site", "latest", "index.md");
  if (fs.existsSync(versionDoc)) {
    const content = fs.readFileSync(versionDoc, "utf8");
    const matches = [...content.matchAll(/`(\d+\.\d+\.\d+)`:\s+current release snapshot/gu)];
    if (matches.length > 0) {
      return matches[matches.length - 1][1];
    }
  }

  const siteRoot = path.join(rootDir, "apps", "docs", "site");
  if (!fs.existsSync(siteRoot)) {
    return "unknown";
  }
  const snapshots = fs.readdirSync(siteRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .map((name) => ({ name, parsed: parseSemver(name) }))
    .filter((entry) => entry.parsed);
  if (snapshots.length === 0) {
    return "unknown";
  }
  snapshots.sort((left, right) => compareSemver(left.parsed, right.parsed));
  return snapshots[snapshots.length - 1].name;
}
