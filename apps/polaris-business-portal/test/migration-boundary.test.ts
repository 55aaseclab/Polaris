import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import YAML from "yaml";

const PORTAL_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const REPO_ROOT = path.resolve(PORTAL_ROOT, "../..");

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".next")) continue;
      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(filePath);
      else if (/\.(?:ts|tsx|mjs|json)$/u.test(entry.name)) files.push(filePath);
    }
  };
  visit(root);
  return files;
}

test("business portal uses Polaris-owned packages and workflow templates", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(PORTAL_ROOT, "package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  assert.equal(packageJson.dependencies?.["@polaris/business-core"], "workspace:*");
  assert.equal(packageJson.dependencies?.["polaris-workflow"], "workspace:*");
  assert.equal(fs.existsSync(path.join(REPO_ROOT, "packs/business/templates.yaml")), true);

  const config = YAML.parse(
    fs.readFileSync(path.join(REPO_ROOT, "packs/business/templates.yaml"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(config.schema_version, "clue.polaris.business.config.v1");
  assert.equal(
    (config.workspace as Record<string, unknown>).root_env,
    "POLARIS_BUSINESS_WORKSPACES_ROOT",
  );
});

test("business portal source has no Wanghai package or host-path dependency", () => {
  for (const filePath of sourceFiles(PORTAL_ROOT)) {
    const source = fs.readFileSync(filePath, "utf8");
    assert.doesNotMatch(source, /(?:from|require\()\s*["']@wanghai\//u, filePath);
    assert.doesNotMatch(source, /\/home\/[^\s"']+/u, filePath);
    assert.doesNotMatch(source, /skills\/workflow-literature-review/u, filePath);
  }
});
