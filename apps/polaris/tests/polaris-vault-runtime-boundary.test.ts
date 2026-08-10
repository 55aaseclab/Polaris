import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptsRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
);

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(fullPath));
      continue;
    }
    if (/\.(?:js|mjs|mts|ts)$/u.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

test("Polaris reaches vault-runtime only through scripts/backends", () => {
  const violations = sourceFiles(scriptsRoot)
    .filter((filePath) => {
      const relativePath = path.relative(scriptsRoot, filePath).split(path.sep).join("/");
      return fs.readFileSync(filePath, "utf8").includes("@polaris/vault-runtime")
        && relativePath !== "backends/vault-runtime-adapter.ts";
    })
    .map((filePath) => path.relative(scriptsRoot, filePath).split(path.sep).join("/"));

  assert.deepEqual(violations, []);
});
