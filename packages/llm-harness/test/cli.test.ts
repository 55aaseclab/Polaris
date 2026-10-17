import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { isClhError } from "../src/errors.js";
import { loadContext, parseArgs } from "../src/cli.js";

test("parseArgs keeps boolean flags from consuming the next token", () => {
  const args = parseArgs(["--dry-run", "preset.yaml"]);
  assert.deepEqual(args.positional, ["preset.yaml"]);
  assert.equal(args.flags.get("dry-run"), "true");
});

test("parseArgs value flags do not cascade into other flags", () => {
  const eaten = parseArgs(["--context", "--dry-run", "preset.yaml"]);
  assert.equal(eaten.flags.get("context"), "");
  assert.equal(eaten.flags.get("dry-run"), "true");
  assert.deepEqual(eaten.positional, ["preset.yaml"]);

  const mid = parseArgs(["--context", "--workspace-root", "/tmp/x", "preset.yaml"]);
  assert.equal(mid.flags.get("context"), "");
  assert.equal(mid.flags.get("workspace-root"), "/tmp/x");
  assert.deepEqual(mid.positional, ["preset.yaml"]);
});

test("parseArgs keeps value flags followed by values", () => {
  const args = parseArgs(["preset.yaml", "--context", '{"ID":"a"}', "--timeout-ms", "5"]);
  assert.deepEqual(args.positional, ["preset.yaml"]);
  assert.equal(args.flags.get("context"), '{"ID":"a"}');
  assert.equal(args.flags.get("timeout-ms"), "5");
});

test("loadContext reads @-prefixed and bare file paths plus inline JSON", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "clh-cli-"));
  try {
    const file = path.join(dir, "context.json");
    writeFileSync(file, '{"ID":"from-file"}');
    assert.deepEqual(loadContext(`@${file}`), { ID: "from-file" });
    assert.deepEqual(loadContext(file), { ID: "from-file" });
    assert.deepEqual(loadContext('{"ID":"inline"}'), { ID: "inline" });
    assert.deepEqual(loadContext(undefined), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadContext fails closed on a missing file that is not inline JSON", () => {
  assert.throws(
    () => loadContext("/nonexistent/clh-context.json"),
    (error: unknown) => isClhError(error) && error.code === "CLH_PRESET_INVALID",
  );
});
