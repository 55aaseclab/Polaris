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
  // TS-backed tools (TS/pnpm stack, no Python runtime) declare no python
  // prerequisites.
  const nonPythonTools = new Set([
    "pdf.capture",
    "literature.source.curated-web",
    "cve.processor",
    "cve.builder",
    "cve.exploiter",
    "cve.verifier",
  ]);
  for (const lock of locks) {
    assert.ok(fs.existsSync(lock.checkSetupPath), `${lock.toolId} check-setup`);
    assert.ok(Array.isArray(lock.prerequisites.env), `${lock.toolId} env`);
    if (!nonPythonTools.has(lock.toolId)) {
      assert.ok(lock.prerequisites.python, `${lock.toolId} must declare python requirements`);
      assert.ok(Array.isArray(lock.prerequisites.python.requirements), `${lock.toolId} requirements`);
    }
  }
});

test("host tool defaults point Polaristool cache aliases at $DATA_ROOT/cache", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-tool-defaults-"));
  const previousData = process.env.POLARIS_DATA_ROOT;
  const previousCache = process.env.POLARIS_LITERATURE_CACHE_ROOT;
  const previousKey = process.env.POLARIS_LITERATURE_SEMANTIC_SCHOLAR_API_KEY;
  const previousShort = process.env.SEMANTIC_SCHOLAR_API_KEY;
  const previousDeepsec = process.env.POLARIS_LITERATURE_DEEPSEC_API_URL;
  process.env.POLARIS_DATA_ROOT = root;
  delete process.env.POLARIS_LITERATURE_CACHE_ROOT;
  delete process.env.POLARIS_LITERATURE_SEMANTIC_SCHOLAR_API_KEY;
  delete process.env.SEMANTIC_SCHOLAR_API_KEY;
  process.env.POLARIS_LITERATURE_DEEPSEC_API_URL = "http://deepsec.test/search";
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
    if (previousKey === undefined) delete process.env.POLARIS_LITERATURE_SEMANTIC_SCHOLAR_API_KEY;
    else process.env.POLARIS_LITERATURE_SEMANTIC_SCHOLAR_API_KEY = previousKey;
    if (previousShort === undefined) delete process.env.SEMANTIC_SCHOLAR_API_KEY;
    else process.env.SEMANTIC_SCHOLAR_API_KEY = previousShort;
    if (previousDeepsec === undefined) delete process.env.POLARIS_LITERATURE_DEEPSEC_API_URL;
    else process.env.POLARIS_LITERATURE_DEEPSEC_API_URL = previousDeepsec;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ops tool-precheck reports lock-declared recommended env without failing required cache defaults", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-tool-precheck-"));
  const previousData = process.env.POLARIS_DATA_ROOT;
  const previousCache = process.env.POLARIS_LITERATURE_CACHE_ROOT;
  const previousKey = process.env.POLARIS_LITERATURE_SEMANTIC_SCHOLAR_API_KEY;
  const previousShort = process.env.SEMANTIC_SCHOLAR_API_KEY;
  const previousDeepsec = process.env.POLARIS_LITERATURE_DEEPSEC_API_URL;
  process.env.POLARIS_DATA_ROOT = root;
  delete process.env.POLARIS_LITERATURE_CACHE_ROOT;
  delete process.env.POLARIS_LITERATURE_SEMANTIC_SCHOLAR_API_KEY;
  delete process.env.SEMANTIC_SCHOLAR_API_KEY;
  process.env.POLARIS_LITERATURE_DEEPSEC_API_URL = "http://deepsec.test/search";
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
    if (previousShort === undefined) delete process.env.SEMANTIC_SCHOLAR_API_KEY;
    else process.env.SEMANTIC_SCHOLAR_API_KEY = previousShort;
    if (previousDeepsec === undefined) delete process.env.POLARIS_LITERATURE_DEEPSEC_API_URL;
    else process.env.POLARIS_LITERATURE_DEEPSEC_API_URL = previousDeepsec;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("host tool defaults copy CODEX_BIN or a PATH codex onto the Polaristool Codex key", () => {
  const previousLong = process.env.POLARIS_LITERATURE_CODEX_BIN;
  const previousShort = process.env.CODEX_BIN;
  delete process.env.POLARIS_LITERATURE_CODEX_BIN;
  process.env.CODEX_BIN = "/usr/bin/codex";
  try {
    applyHostToolDefaults(import.meta.url);
    assert.equal(process.env.POLARIS_LITERATURE_CODEX_BIN, "/usr/bin/codex");
    const report = evaluatePortalToolStatus(import.meta.url);
    const missingCodexEnv = report.tools.some((tool) =>
      tool.missingRecommended.some((item) => item.key === "POLARIS_LITERATURE_CODEX_BIN")
    );
    assert.equal(missingCodexEnv, false);
  } finally {
    if (previousLong === undefined) delete process.env.POLARIS_LITERATURE_CODEX_BIN;
    else process.env.POLARIS_LITERATURE_CODEX_BIN = previousLong;
    if (previousShort === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previousShort;
  }
});

test("host tool defaults copy DEEPSEC_API_URL onto the Polaristool DeepSec key and do not invent a host", () => {
  const previousLong = process.env.POLARIS_LITERATURE_DEEPSEC_API_URL;
  const previousShort = process.env.DEEPSEC_API_URL;
  const previousData = process.env.POLARIS_DATA_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-deepsec-defaults-"));
  process.env.POLARIS_DATA_ROOT = root;
  delete process.env.POLARIS_LITERATURE_DEEPSEC_API_URL;
  delete process.env.DEEPSEC_API_URL;
  try {
    applyHostToolDefaults(import.meta.url);
    assert.equal(process.env.POLARIS_LITERATURE_DEEPSEC_API_URL, undefined);
    const missing = evaluatePortalToolStatus(import.meta.url);
    const deepsec = missing.tools.find((tool) => tool.id === "literature.source.deepsec");
    assert.ok(deepsec);
    assert.equal(deepsec.readiness, "blocked");
    assert.equal(
      deepsec.missingRequired.some((item) => item.key === "POLARIS_LITERATURE_DEEPSEC_API_URL"),
      true,
    );
    process.env.DEEPSEC_API_URL = "http://deepsec.test/search";
    applyHostToolDefaults(import.meta.url);
    assert.equal(process.env.POLARIS_LITERATURE_DEEPSEC_API_URL, "http://deepsec.test/search");
    const present = evaluatePortalToolStatus(import.meta.url);
    const ready = present.tools.find((tool) => tool.id === "literature.source.deepsec");
    assert.ok(ready);
    assert.equal(
      ready.missingRequired.some((item) => item.key === "POLARIS_LITERATURE_DEEPSEC_API_URL"),
      false,
    );
  } finally {
    if (previousLong === undefined) delete process.env.POLARIS_LITERATURE_DEEPSEC_API_URL;
    else process.env.POLARIS_LITERATURE_DEEPSEC_API_URL = previousLong;
    if (previousShort === undefined) delete process.env.DEEPSEC_API_URL;
    else process.env.DEEPSEC_API_URL = previousShort;
    if (previousData === undefined) delete process.env.POLARIS_DATA_ROOT;
    else process.env.POLARIS_DATA_ROOT = previousData;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("host tool defaults copy SEMANTIC_SCHOLAR_API_KEY onto the Polaristool scholar key", () => {
  const previousLong = process.env.POLARIS_LITERATURE_SEMANTIC_SCHOLAR_API_KEY;
  const previousShort = process.env.SEMANTIC_SCHOLAR_API_KEY;
  delete process.env.POLARIS_LITERATURE_SEMANTIC_SCHOLAR_API_KEY;
  process.env.SEMANTIC_SCHOLAR_API_KEY = "alias-key";
  try {
    applyHostToolDefaults(import.meta.url);
    assert.equal(process.env.POLARIS_LITERATURE_SEMANTIC_SCHOLAR_API_KEY, "alias-key");
    const report = evaluatePortalToolStatus(import.meta.url);
    const scholar = report.tools.find((tool) => tool.id === "literature.source.semantic-scholar");
    assert.ok(scholar);
    assert.equal(
      scholar.missingRecommended.some((item) => item.key === "POLARIS_LITERATURE_SEMANTIC_SCHOLAR_API_KEY"),
      false,
    );
  } finally {
    if (previousLong === undefined) delete process.env.POLARIS_LITERATURE_SEMANTIC_SCHOLAR_API_KEY;
    else process.env.POLARIS_LITERATURE_SEMANTIC_SCHOLAR_API_KEY = previousLong;
    if (previousShort === undefined) delete process.env.SEMANTIC_SCHOLAR_API_KEY;
    else process.env.SEMANTIC_SCHOLAR_API_KEY = previousShort;
  }
});

test("portal tool status marks recommended-only gaps as warning", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-tool-status-"));
  const previousData = process.env.POLARIS_DATA_ROOT;
  const previousCache = process.env.POLARIS_LITERATURE_CACHE_ROOT;
  const previousKey = process.env.POLARIS_LITERATURE_SEMANTIC_SCHOLAR_API_KEY;
  const previousShort = process.env.SEMANTIC_SCHOLAR_API_KEY;
  const previousDeepsec = process.env.POLARIS_LITERATURE_DEEPSEC_API_URL;
  process.env.POLARIS_DATA_ROOT = root;
  delete process.env.POLARIS_LITERATURE_CACHE_ROOT;
  delete process.env.POLARIS_LITERATURE_SEMANTIC_SCHOLAR_API_KEY;
  delete process.env.SEMANTIC_SCHOLAR_API_KEY;
  process.env.POLARIS_LITERATURE_DEEPSEC_API_URL = "http://deepsec.test/search";
  try {
    const report = evaluatePortalToolStatus(import.meta.url);
    const scholar = report.tools.find((tool) => tool.id === "literature.source.semantic-scholar");
    assert.ok(scholar);
    assert.equal(scholar.readiness, "warning");
    assert.equal(scholar.lockPath, "tools/semantic-scholar/backend.lock.json");
    assert.equal(scholar.checkSetupPath, "tools/semantic-scholar/check-setup");
    assert.equal(scholar.checkSetup.ok, true);
    assert.equal(
      scholar.checkSetup.checked.some((item) => item.key === "POLARIS_LITERATURE_SEMANTIC_SCHOLAR_API_KEY"),
      true,
    );
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
    if (previousShort === undefined) delete process.env.SEMANTIC_SCHOLAR_API_KEY;
    else process.env.SEMANTIC_SCHOLAR_API_KEY = previousShort;
    if (previousDeepsec === undefined) delete process.env.POLARIS_LITERATURE_DEEPSEC_API_URL;
    else process.env.POLARIS_LITERATURE_DEEPSEC_API_URL = previousDeepsec;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
