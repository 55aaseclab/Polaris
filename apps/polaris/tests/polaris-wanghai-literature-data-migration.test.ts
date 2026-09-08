import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyWanghaiLiteratureDataMigration,
  createWanghaiLiteratureDataMigrationPlan,
  rollbackWanghaiLiteratureDataMigration,
  verifyWanghaiLiteratureDataMigration,
  writeWanghaiLiteratureDataDryRunReport,
} from "../scripts/migrations/wanghai-literature-data.js";

function withFixture(run: (root: string, report: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-wanghai-literature-migration-"));
  const source = path.join(root, "source");
  const archive = path.join(root, "archive");
  const report = path.join(root, "reports", "migration.json");
  fs.mkdirSync(path.join(source, "data-collections", "case-a", "outputs"), { recursive: true });
  fs.mkdirSync(path.join(source, "workflows", "case-a", "intelligence-analysis"), { recursive: true });
  fs.mkdirSync(path.join(source, "report-writing"), { recursive: true });
  fs.mkdirSync(path.join(source, "assets"), { recursive: true });
  fs.writeFileSync(path.join(source, "data-collections", "case-a", "outputs", "output.json"), "synthetic collection\n");
  fs.writeFileSync(path.join(source, "workflows", "case-a", "intelligence-analysis", "output.json"), "synthetic analysis\n");
  fs.mkdirSync(path.join(source, "workflows", "case-a", "__pycache__"), { recursive: true });
  fs.writeFileSync(path.join(source, "workflows", "case-a", "__pycache__", "runner.pyc"), "generated\n");
  fs.symlinkSync("/tmp/missing-literature-target", path.join(source, "workflows", "case-a", "runtime-link"));
  for (const file of ["workspace.json", "workspace-layout.json", "workflows.yaml", "README.md", "MOVE-LOG.txt"]) {
    fs.writeFileSync(path.join(source, file), file);
  }
  try {
    run(root, report);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function planFor(root: string) {
  return createWanghaiLiteratureDataMigrationPlan({
    sourceRoot: path.join(root, "source"),
    archiveRoot: path.join(root, "archive"),
    scope: {
      tenantId: "synthetic-tenant",
      vaultId: "synthetic-vault",
      workspaceId: "literature-review",
    },
  });
}

test("literature data dry-run is metadata-only and records excluded runtime material", () => {
  withFixture((root, reportPath) => {
    const plan = planFor(root);
    assert.equal(fs.existsSync(plan.targetRoot), false);
    assert.equal(plan.sourceInventory.symlinks.length, 1);
    assert.equal(plan.sourceInventory.excludedDirectories.length, 1);
    const report = writeWanghaiLiteratureDataDryRunReport(reportPath, plan);
    assert.equal(report.state, "planned");
    assert.equal(fs.existsSync(plan.targetRoot), false);
  });
});
test("literature data apply scopes the archive and verifies byte-preserving copies", () => {
  withFixture((root, reportPath) => {
    const plan = planFor(root);
    const report = applyWanghaiLiteratureDataMigration({ plan, reportPath });
    assert.equal(report.state, "applied");
    assert.equal(report.historicalOnly, true);
    assert.equal(fs.readFileSync(path.join(plan.targetRoot, "data-collections", "case-a", "outputs", "output.json"), "utf8"), "synthetic collection\n");
    assert.equal(fs.existsSync(path.join(plan.targetRoot, "legacy-workflows", "case-a", "__pycache__")), false);
    assert.equal(fs.existsSync(path.join(plan.targetRoot, "legacy-workflows", "case-a", "runtime-link")), false);
    assert.equal(fs.existsSync(path.join(plan.targetRoot, "IMPORT.json")), true);
    assert.equal(verifyWanghaiLiteratureDataMigration({ reportPath, archiveRoot: plan.archiveRoot }).valid, true);
  });
});

test("literature data rollback refuses changed entries and removes an unchanged archive", () => {
  withFixture((root, reportPath) => {
    const plan = planFor(root);
    applyWanghaiLiteratureDataMigration({ plan, reportPath });
    fs.writeFileSync(path.join(plan.targetRoot, "data-collections", "case-a", "outputs", "output.json"), "changed\n");
    assert.throws(
      () => rollbackWanghaiLiteratureDataMigration({ reportPath, archiveRoot: plan.archiveRoot }),
      /changed literature entry/i,
    );
    fs.writeFileSync(path.join(plan.targetRoot, "data-collections", "case-a", "outputs", "output.json"), "synthetic collection\n");
    const rolledBack = rollbackWanghaiLiteratureDataMigration({ reportPath, archiveRoot: plan.archiveRoot });
    assert.equal(rolledBack.state, "rolled-back");
    assert.equal(fs.existsSync(plan.targetRoot), false);
  });
});
