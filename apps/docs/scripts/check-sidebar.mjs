import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const docsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../site");
const outputFile = path.join(docsRoot, ".vitepress", "dist", "index.html");

function markdownFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...markdownFiles(entryPath));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(entryPath);
  }
  return files;
}

function routeFor(filePath) {
  const relative = path.relative(docsRoot, filePath).split(path.sep).join("/");
  const withoutExtension = relative.replace(/\.md$/u, "");
  if (withoutExtension === "index") return "/";
  if (withoutExtension.endsWith("/index")) {
    return `/${withoutExtension.slice(0, -"/index".length)}/`;
  }
  return `/${withoutExtension}`;
}

assert.ok(fs.existsSync(outputFile), `VitePress output is missing: ${outputFile}`);
const generated = fs.readFileSync(outputFile, "utf8");
const routes = markdownFiles(docsRoot).map(routeFor);
const missing = routes
  .filter((route) => !generated.includes(`\\"link\\":\\"${route}\\"`));

assert.deepEqual(missing, [], `sidebar is missing generated routes: ${missing.join(", ")}`);
console.log(`sidebar route check: ${routes.length} routes present`);
