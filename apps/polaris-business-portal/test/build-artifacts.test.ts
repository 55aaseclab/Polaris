import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, "../../..");

test("business portal build ignores transient Next dist dirs", () => {
  const dockerignore = readFileSync(path.join(REPO_ROOT, ".dockerignore"), "utf8");
  assert.match(dockerignore, /apps\/polaris-business-portal\/\.next\*/);

  const tsconfig = readFileSync(path.join(REPO_ROOT, "apps/polaris-business-portal/tsconfig.json"), "utf8");
  assert.match(tsconfig, /"\.next\/types\/\*\*\/\*\.ts"/);
  assert.match(tsconfig, /"\.next-local-dev\/types\/\*\*\/\*\.ts"/);
  assert.doesNotMatch(tsconfig, /\.next-dev-9090\/types/);
});
