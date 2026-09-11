import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "../scripts/cli/main.js";
import { applyHostToolDefaults } from "../scripts/tools/defaults.js";
import { readHostToolBackendLocks } from "../scripts/tools/inventory.js";
import { evaluateToolPrecheck } from "../scripts/tools/precheck.js";
import { evaluatePortalToolStatus } from "../scripts/tools/status.js";
import { polarisCacheRoot } from "../scripts/utils/paths.js";

async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
    return chunks.join("");
  } finally {
    process.stdout.write = originalWrite;
  }
}

test("every common tool lock declares prerequisites and Python tools declare requirements", () => {
  const locks = readHostToolBackendLocks(import.meta.url);
  assert.ok(locks.length > 0);
  for (const lock of locks) {
    assert.ok(fs.existsSync(lock.checkSetupPath), `${lock.toolId} check-setup`);
    assert.ok(Array.isArray(lock.prerequisites.env), `${lock.toolId} env`);
    const pythonTool = lock.toolId !== "literature.pdf.capture"
      && lock.toolId !== "literature.source.curated-web";
    if (pythonTool) {
      assert.ok(lock.prerequisites.python, `${lock.toolId} must declare python requirements`);
      assert.ok(Array.isArray(lock.prerequisites.python.requirements), `${lock.toolId} requirements`);
    }
  }
});

test("host tool defaults point Polaristool cache aliases at $DATA_ROOT/cache", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-tool-defaults-"));
  const previousData = process.env.POLARIS_DATA_ROOT;
  const previousCache = process.env.POLARIS_LITERATURE_CACHE_ROOT;
  process.env.POLARIS_DATA_ROOT = root;
  delete process.env.POLARIS_LITERATURE_CACHE_ROOT;
  try {
    applyHostToolDefaults(import.meta.url);
    assert.equal(process.env.POLARIS_LITERATURE_CACHE_ROOT, polarisCacheRoot(import.meta.url));
    const report = evaluateToolPrecheck(import.meta.url);
    assert.equal(report.ok, true);
    assert.equal(report.missingRequired.length, 0);
    assert.equal(
      report.missingRecommended.some((item) => item.key === "POLARIS_LITERATURE_SEMANTIC_SCHOLAR_API_KEY"),
      true,
    );
  } finally {
    if (previousData === undefined) delete process.env.POLARIS_DATA_ROOT;
    else process.env.POLARIS_DATA_ROOT = previousData;
    if (previousCache === undefined) delete process.env.POLARIS_LITERATURE_CACHE_ROOT;
    else process.env.POLARIS_LITERATURE_CACHE_ROOT = previousCache;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ops tool-precheck reports lock-declared recommended env without failing required cache defaults", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-tool-precheck-"));
  const previousData = process.env.POLARIS_DATA_ROOT;
  const previousCache = process.env.POLARIS_LITERATURE_CACHE_ROOT;
  const previousKey = process.env.POLARIS_LITERATURE_SEMANTIC_SCHOLAR_API_KEY;
  process.env.POLARIS_DATA_ROOT = root;
  delete process.env.POLARIS_LITERATURE_CACHE_ROOT;
  delete process.env.POLARIS_LITERATURE_SEMANTIC_SCHOLAR_API_KEY;
  try {
    const output = await captureStdout(async () => {
      await runCli(["ops", "tool-precheck", "--json"]);
    });
    const parsed = JSON.parse(output) as {
      ok: boolean;
      missingRequired: Array<{ key: string; toolId: string }>;
      missingRecommended: Array<{ key: string; toolId: string }>;
    };
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.missingRequired, []);
    assert.equal(
      parsed.missingRecommended.some((item) =>
        item.toolId === "literature.source.semantic-scholar"
        && item.key === "POLARIS_LITERATURE_SEMANTIC_SCHOLAR_API_KEY"
        && Boolean(item.next)
      ),
      true,
    );
  } finally {
    if (previousData === undefined) delete process.env.POLARIS_DATA_ROOT;
    else process.env.POLARIS_DATA_ROOT = previousData;
    if (previousCache === undefined) delete process.env.POLARIS_LITERATURE_CACHE_ROOT;
    else process.env.POLARIS_LITERATURE_CACHE_ROOT = previousCache;
    if (previousKey === undefined) delete process.env.POLARIS_LITERATURE_SEMANTIC_SCHOLAR_API_KEY;
    else process.env.POLARIS_LITERATURE_SEMANTIC_SCHOLAR_API_KEY = previousKey;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("portal tool status marks recommended-only gaps as warning", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-tool-status-"));
  const previousData = process.env.POLARIS_DATA_ROOT;
  const previousCache = process.env.POLARIS_LITERATURE_CACHE_ROOT;
  const previousKey = process.env.POLARIS_LITERATURE_SEMANTIC_SCHOLAR_API_KEY;
  process.env.POLARIS_DATA_ROOT = root;
  delete process.env.POLARIS_LITERATURE_CACHE_ROOT;
  delete process.env.POLARIS_LITERATURE_SEMANTIC_SCHOLAR_API_KEY;
  try {
    const report = evaluatePortalToolStatus(import.meta.url);
    const scholar = report.tools.find((tool) => tool.id === "literature.source.semantic-scholar");
    assert.ok(scholar);
    assert.equal(scholar.readiness, "warning");
    assert.equal(scholar.lockPath, "tools/semantic-scholar/backend.lock.json");
    assert.equal(scholar.checkSetupPath, "tools/semantic-scholar/check-setup");
    assert.equal(scholar.checkSetup.ok, true);
    assert.equal(
      scholar.checkSetup.lines.some((line) => line.includes("POLARIS_LITERATURE_SEMANTIC_SCHOLAR_API_KEY")),
      true,
    );
    assert.deepEqual(scholar.missingRequired, []);
    assert.equal(
      scholar.missingRecommended.some((item) => item.key === "POLARIS_LITERATURE_SEMANTIC_SCHOLAR_API_KEY"),
      true,
    );
    assert.equal(report.ok, true);
    assert.equal(report.blocked, 0);
    assert.ok(report.warning >= 1);
  } finally {
    if (previousData === undefined) delete process.env.POLARIS_DATA_ROOT;
    else process.env.POLARIS_DATA_ROOT = previousData;
    if (previousCache === undefined) delete process.env.POLARIS_LITERATURE_CACHE_ROOT;
    else process.env.POLARIS_LITERATURE_CACHE_ROOT = previousCache;
    if (previousKey === undefined) delete process.env.POLARIS_LITERATURE_SEMANTIC_SCHOLAR_API_KEY;
    else process.env.POLARIS_LITERATURE_SEMANTIC_SCHOLAR_API_KEY = previousKey;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
