import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { vaultDataRelativePath } from "../scripts/config/scaffold.js";
import { resolveWanghaiHostDataRootsAtRoot } from "../scripts/config/wanghai-env.js";
import { runWanghaiDataRootMigrationCli } from "../scripts/migrate-wanghai-data-root.js";
import {
  applyWanghaiDataRootMigration,
  createWanghaiDataRootMigrationPlan,
  rollbackWanghaiDataRootMigration,
  verifyWanghaiDataRootMigration,
  writeWanghaiMigrationDryRunReport,
  type WanghaiMigrationManifest,
} from "../scripts/migrations/wanghai-data-root.js";

function migrationManifest(): WanghaiMigrationManifest {
  return {
    version: 1,
    mappings: [
      {
        tenantId: "synthetic-tenant-a",
        vaultId: "synthetic-vault-a",
        workspaces: [{ source: "workspace-a" }],
        backups: [{ source: "workspace-a.backup", target: "workspace-a.backup" }],
        cache: [{ source: "thumbnails/workspace-a", target: "thumbnails/workspace-a" }],
      },
    ],
  };
}

function seedLegacyRoot(root: string): void {
  fs.mkdirSync(path.join(root, "vaults", "workspace-a"), { recursive: true });
  fs.mkdirSync(path.join(root, "backups"), { recursive: true });
  fs.mkdirSync(path.join(root, "cache", "thumbnails", "workspace-a"), { recursive: true });
  fs.writeFileSync(path.join(root, "vaults", "workspace-a", "notes.txt"), "synthetic workspace data\n");
  fs.writeFileSync(path.join(root, "backups", "workspace-a.backup"), "synthetic backup\n");
  fs.writeFileSync(path.join(root, "cache", "thumbnails", "workspace-a", "thumb.txt"), "synthetic thumbnail\n");
}

function withRoots(run: (legacyRoot: string, targetRoot: string, reportPath: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-wanghai-migration-"));
  const legacyRoot = path.join(root, "legacy");
  const targetRoot = path.join(root, "target");
  const reportPath = path.join(root, "reports", "migration.json");
  try {
    seedLegacyRoot(legacyRoot);
    run(legacyRoot, targetRoot, reportPath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("Wanghai migration dry-run is metadata-only and does not create tenant roots", () => {
  withRoots((legacyRoot, targetRoot, reportPath) => {
    const plan = createWanghaiDataRootMigrationPlan({
      manifest: migrationManifest(),
      legacyRoot,
      targetRoot,
    });
    assert.equal(plan.entries.length, 3);
    assert.equal(fs.existsSync(targetRoot), false);

    const report = writeWanghaiMigrationDryRunReport(reportPath, plan);
    assert.equal(report.mode, "dry-run");
    assert.equal(report.state, "planned");
    assert.equal(fs.existsSync(targetRoot), false);
  });
});

test("Wanghai migration CLI defaults to a dry-run report", () => {
  withRoots((legacyRoot, targetRoot, reportPath) => {
    const manifestPath = path.join(path.dirname(reportPath), "manifest.json");
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, `${JSON.stringify(migrationManifest())}\n`);
    const report = runWanghaiDataRootMigrationCli([
      "--manifest",
      manifestPath,
      "--legacy-root",
      legacyRoot,
      "--target-root",
      targetRoot,
      "--report",
      reportPath,
    ]) as { mode: string; state: string };
    assert.equal(report.mode, "dry-run");
    assert.equal(report.state, "planned");
    assert.equal(fs.existsSync(targetRoot), false);
  });
});

test("Wanghai migration copies verified tenant-qualified roots and supports rollback", () => {
  withRoots((legacyRoot, targetRoot, reportPath) => {
    const manifest = migrationManifest();
    const plan = createWanghaiDataRootMigrationPlan({ manifest, legacyRoot, targetRoot });
    const report = applyWanghaiDataRootMigration({ plan, reportPath });
    assert.equal(report.state, "applied");
    const roots = resolveWanghaiHostDataRootsAtRoot(targetRoot, {
      tenantId: "synthetic-tenant-a",
      vaultId: "synthetic-vault-a",
    });
    const mountedVaultRoot = path.join(
      targetRoot,
      vaultDataRelativePath("synthetic-tenant-a", "synthetic-vault-a"),
    );
    assert.equal(roots.workspacesRoot, path.join(mountedVaultRoot, "workspaces"));
    assert.equal(roots.backupRoot, path.join(mountedVaultRoot, "backups"));
    assert.equal(roots.cacheRoot, path.join(mountedVaultRoot, "cache"));
    assert.equal(
      fs.readFileSync(path.join(roots.workspacesRoot, "workspace-a", "notes.txt"), "utf8"),
      "synthetic workspace data\n",
    );
    assert.equal(
      fs.readFileSync(path.join(roots.backupRoot, "workspace-a.backup"), "utf8"),
      "synthetic backup\n",
    );
    assert.equal(
      fs.readFileSync(path.join(roots.cacheRoot, "thumbnails", "workspace-a", "thumb.txt"), "utf8"),
      "synthetic thumbnail\n",
    );
    assert.equal(
      fs.readFileSync(path.join(legacyRoot, "vaults", "workspace-a", "notes.txt"), "utf8"),
      "synthetic workspace data\n",
    );
    assert.equal(verifyWanghaiDataRootMigration({ reportPath, targetRoot }).entries.length, 3);

    const rolledBack = rollbackWanghaiDataRootMigration({ reportPath, targetRoot });
    assert.equal(rolledBack.state, "rolled-back");
    assert.equal(fs.existsSync(path.join(roots.workspacesRoot, "workspace-a")), false);
    assert.equal(fs.existsSync(path.join(roots.backupRoot, "workspace-a.backup")), false);
    assert.equal(fs.existsSync(path.join(roots.cacheRoot, "thumbnails", "workspace-a")), false);
    assert.equal(fs.existsSync(path.join(legacyRoot, "vaults", "workspace-a", "notes.txt")), true);
  });
});

test("Wanghai migration refuses traversal, overlapping mappings, and symbolic links", () => {
  withRoots((legacyRoot, targetRoot) => {
    const traversal = migrationManifest();
    traversal.mappings[0]!.workspaces = [{ source: "../outside" }];
    assert.throws(
      () => createWanghaiDataRootMigrationPlan({ manifest: traversal, legacyRoot, targetRoot }),
      /relative path without traversal/i,
    );

    const overlapping = migrationManifest();
    overlapping.mappings.push({
      tenantId: "synthetic-tenant-b",
      vaultId: "synthetic-vault-b",
      workspaces: [{ source: "workspace-a" }],
    });
    assert.throws(
      () => createWanghaiDataRootMigrationPlan({ manifest: overlapping, legacyRoot, targetRoot }),
      /source paths overlap/i,
    );

    fs.symlinkSync(path.join(legacyRoot, "vaults", "workspace-a"), path.join(legacyRoot, "vaults", "linked"));
    const linked = migrationManifest();
    linked.mappings[0]!.workspaces = [{ source: "linked" }];
    assert.throws(
      () => createWanghaiDataRootMigrationPlan({ manifest: linked, legacyRoot, targetRoot }),
      /symbolic link/i,
    );
  });
});

test("Wanghai rollback refuses to delete a target that changed after migration", () => {
  withRoots((legacyRoot, targetRoot, reportPath) => {
    const plan = createWanghaiDataRootMigrationPlan({
      manifest: migrationManifest(),
      legacyRoot,
      targetRoot,
    });
    applyWanghaiDataRootMigration({ plan, reportPath });
    const roots = resolveWanghaiHostDataRootsAtRoot(targetRoot, {
      tenantId: "synthetic-tenant-a",
      vaultId: "synthetic-vault-a",
    });
    fs.writeFileSync(path.join(roots.workspacesRoot, "workspace-a", "notes.txt"), "changed\n");
    assert.throws(
      () => rollbackWanghaiDataRootMigration({ reportPath, targetRoot }),
      /refusing to roll back changed target/i,
    );
    assert.equal(fs.existsSync(path.join(roots.workspacesRoot, "workspace-a", "notes.txt")), true);
  });
});

test("Wanghai rollback rejects a tampered staging path before modifying vault data", () => {
  withRoots((legacyRoot, targetRoot, reportPath) => {
    const plan = createWanghaiDataRootMigrationPlan({
      manifest: migrationManifest(),
      legacyRoot,
      targetRoot,
    });
    applyWanghaiDataRootMigration({ plan, reportPath });
    const roots = resolveWanghaiHostDataRootsAtRoot(targetRoot, {
      tenantId: "synthetic-tenant-a",
      vaultId: "synthetic-vault-a",
    });
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as Record<string, unknown>;
    report.stagingPath = roots.workspacesRoot;
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");

    assert.throws(
      () => rollbackWanghaiDataRootMigration({ reportPath, targetRoot }),
      /staging path does not match its run ID/i,
    );
    assert.equal(fs.existsSync(path.join(roots.workspacesRoot, "workspace-a", "notes.txt")), true);
  });
});
