import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runHostCacheMigrationCli } from "../scripts/migrate-host-cache.js";
import {
  applyHostCacheMigration,
  createHostCacheMigrationPlan,
  rollbackHostCacheMigration,
  verifyHostCacheMigration,
  writeHostCacheDryRunReport,
} from "../scripts/migrations/host-cache.js";
import { polarisCacheRoot } from "../scripts/utils/paths.js";

function seedSource(root: string): void {
  fs.mkdirSync(path.join(root, "literature-pdfs", "by-doi"), { recursive: true });
  fs.mkdirSync(path.join(root, "semantic-scholar", "ab"), { recursive: true });
  fs.mkdirSync(path.join(root, "topic-judgments"), { recursive: true });
  fs.writeFileSync(path.join(root, "literature-pdfs", "by-doi", "paper.pdf"), "%PDF-1.4 synthetic\n");
  fs.writeFileSync(path.join(root, "semantic-scholar", "ab", "hit.json"), "{\"title\":\"synthetic\"}\n");
  fs.writeFileSync(path.join(root, "topic-judgments", "judge.json"), "{\"keep\":true}\n");
}

function withRoots(run: (sourceRoot: string, targetRoot: string, reportPath: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-host-cache-"));
  const sourceRoot = path.join(root, "legacy-cache");
  const targetRoot = path.join(root, "data", "cache");
  const reportPath = path.join(root, "reports", "host-cache.json");
  try {
    seedSource(sourceRoot);
    run(sourceRoot, targetRoot, reportPath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("host-cache dry-run is metadata-only and does not create occupants", () => {
  withRoots((sourceRoot, targetRoot, reportPath) => {
    const plan = createHostCacheMigrationPlan({ sourceRoot, targetRoot });
    assert.equal(plan.entries.some((entry) => entry.merge === "copy-new"), true);
    assert.equal(fs.existsSync(targetRoot), false);
    const report = writeHostCacheDryRunReport(reportPath, plan);
    assert.equal(report.mode, "dry-run");
    assert.equal(fs.existsSync(targetRoot), false);
  });
});

test("host-cache apply copies missing occupants and skips already-present trees", () => {
  withRoots((sourceRoot, targetRoot, reportPath) => {
    fs.mkdirSync(path.join(targetRoot, "semantic-scholar"), { recursive: true });
    fs.writeFileSync(path.join(targetRoot, "semantic-scholar", "keep.json"), "{\"keep\":true}\n");
    const plan = createHostCacheMigrationPlan({ sourceRoot, targetRoot });
    const scholar = plan.entries.find((entry) => entry.occupant === "semantic-scholar");
    const pdfs = plan.entries.find((entry) => entry.occupant === "literature-pdfs");
    assert.equal(scholar?.merge, "already-present");
    assert.equal(pdfs?.merge, "copy-new");
    const report = applyHostCacheMigration({ plan, reportPath });
    assert.equal(report.state, "applied");
    assert.equal(
      fs.readFileSync(path.join(targetRoot, "literature-pdfs", "by-doi", "paper.pdf"), "utf8"),
      "%PDF-1.4 synthetic\n",
    );
    assert.equal(
      fs.readFileSync(path.join(targetRoot, "semantic-scholar", "keep.json"), "utf8"),
      "{\"keep\":true}\n",
    );
    assert.equal(fs.existsSync(path.join(targetRoot, "semantic-scholar", "ab", "hit.json")), false);
    assert.equal(verifyHostCacheMigration({ reportPath, targetRoot }).valid, true);
    const rolledBack = rollbackHostCacheMigration({ reportPath, targetRoot });
    assert.equal(rolledBack.state, "rolled-back");
    assert.equal(fs.existsSync(path.join(targetRoot, "literature-pdfs")), false);
    assert.equal(fs.existsSync(path.join(targetRoot, "semantic-scholar", "keep.json")), true);
  });
});

test("host-cache CLI defaults the target to Polaristool $DATA_ROOT/cache", () => {
  withRoots((sourceRoot, _targetRoot, reportPath) => {
    const previous = process.env.POLARIS_DATA_ROOT;
    const dataRoot = path.dirname(_targetRoot);
    process.env.POLARIS_DATA_ROOT = dataRoot;
    try {
      const report = runHostCacheMigrationCli([
        "--source-root",
        sourceRoot,
        "--report",
        reportPath,
      ]) as { targetRoot: string; mode: string };
      assert.equal(report.mode, "dry-run");
      assert.equal(report.targetRoot, polarisCacheRoot(import.meta.url));
      assert.equal(fs.existsSync(path.join(dataRoot, "cache", "literature-pdfs")), false);
    } finally {
      if (previous === undefined) delete process.env.POLARIS_DATA_ROOT;
      else process.env.POLARIS_DATA_ROOT = previous;
    }
  });
});
