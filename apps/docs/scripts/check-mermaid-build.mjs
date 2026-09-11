import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const distRoot = path.resolve("site/.vitepress/dist");
const pageCandidates = [
  path.join(distRoot, "polaris", "gateway.html"),
  path.join(distRoot, "operations", "topology.html"),
  path.join(distRoot, "deployment", "local-development.html"),
];
const pagePath = pageCandidates.find((candidate) => fs.existsSync(candidate));
assert.ok(pagePath, "expected a built Mermaid page");
const pageHtml = fs.readFileSync(pagePath, "utf8");

function collectJsFiles(rootDir) {
  const files = [];
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const absolutePath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectJsFiles(absolutePath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(absolutePath);
    }
  }
  return files;
}

assert.match(
  pageHtml,
  /<pre class="mermaid">/,
  "expected Mermaid containers in the built page",
);

assert.doesNotMatch(
  pageHtml,
  /language-mermaid/,
  "expected Mermaid blocks to stop rendering as plain code fences",
);

const assetRoot = path.join(distRoot, "assets");
const assetBundle = collectJsFiles(assetRoot)
  .map((file) => fs.readFileSync(file, "utf8"))
  .join("\n");

assert.match(
  assetBundle,
  /Mermaid render failed|querySelector:"\.vp-doc div\.mermaid"/,
  "expected the client bundle to include Mermaid runtime rendering",
);

process.stdout.write("mermaid build check: ok\n");
