import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import yaml from "js-yaml";
import { runControlVaultDataMigrationCli } from "../scripts/migrate-control-vault-data.js";
import {
  applyControlVaultDataMigration,
  createControlVaultDataMigrationPlan,
  rollbackControlVaultDataMigration,
  verifyControlVaultDataMigration,
  writeControlVaultDataDryRunReport,
  type ControlVaultDataManifest,
} from "../scripts/migrations/control-vault-data.js";

function manifest(): ControlVaultDataManifest {
  return {
    version: 1,
    entries: [
      { plane: "control", source: "users", target: "control/users" },
      { plane: "control", source: "state", target: "control/state" },
      { plane: "control", source: "backup-keys", target: "control/backup-keys" },
      {
        plane: "vault-data",
        source: "exports/vaults/tenants/tenant-a/vaults/vault-a",
        target: "vault-data/tenants/tenant-a/vaults/vault-a/workspaces",
      },
    ],
    specs: ["users/tenant-a/vaults/vault-a/docker.agent.yaml"],
    ignoredSources: ["control.sqlite"],
  };
}

function seed(root: string): void {
  const specPath = path.join(root, "users/tenant-a/vaults/vault-a/docker.agent.yaml");
  fs.mkdirSync(path.dirname(specPath), { recursive: true });
  fs.writeFileSync(specPath, [
    "project: vault-a",
    "attachments:",
    "  vault-data:",
    "    mount_root: /vault/project",
    "    durable_paths:",
    "      - /vault/project",
    "    source:",
    "      kind: netfs",
    "      sub_path: tenants/tenant-a/vaults/vault-a",
    "      export_path: /old/export",
    "  vault-runtime-state:",
    "    mount_root: /vault/state",
    "    durable_paths: [/vault/state]",
    "    source: {kind: generated-material}",
    "  user-identity-state:",
    "    mount_root: /identity",
    "    durable_paths: [/identity/ssh]",
    "    source: {kind: secret-material}",
    "  ephemeral-runtime:",
    "    mount_root: /run/vault",
    "    paths: [/run/vault/tmp]",
    "    stale_artifacts: [/run/vault/pids/x]",
    "",
  ].join("\n"));
  fs.mkdirSync(path.join(root, "state"), { recursive: true });
  fs.writeFileSync(path.join(root, "state/control.sqlite"), "synthetic sqlite\n");
  fs.mkdirSync(path.join(root, "backup-keys"), { recursive: true });
  fs.writeFileSync(path.join(root, "backup-keys/vault-a.key"), "synthetic key\n");
  fs.mkdirSync(path.join(root, "exports/vaults/tenants/tenant-a/vaults/vault-a/.polaris"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "exports/vaults/tenants/tenant-a/vaults/vault-a/.polaris/MEMORY.md"),
    "synthetic memory\n",
  );
  fs.writeFileSync(path.join(root, "control.sqlite"), "");
}

function withRoots(run: (root: string, reportPath: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-control-vault-migration-"));
  const reportPath = path.join(os.tmpdir(), `polaris-control-vault-report-${process.pid}-${Date.now()}.json`);
  try {
    seed(root);
    run(root, reportPath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(reportPath, { force: true });
  }
}

test("control/vault-data dry-run is metadata-only", () => {
  withRoots((root, reportPath) => {
    const plan = createControlVaultDataMigrationPlan({ manifest: manifest(), legacyRoot: root, targetRoot: root });
    assert.equal(plan.entries.length, 4);
    assert.equal(fs.existsSync(path.join(root, "control")), false);
    const report = writeControlVaultDataDryRunReport(reportPath, plan);
    assert.equal(report.state, "planned");
    assert.equal(fs.existsSync(path.join(root, "control")), false);
  });
});

test("control/vault-data apply rewrites specs and creates direct business roots", () => {
  withRoots((root, reportPath) => {
    fs.chmodSync(path.join(root, "users"), 0o750);
    fs.chmodSync(path.join(root, "users/tenant-a/vaults/vault-a/docker.agent.yaml"), 0o640);
    const plan = createControlVaultDataMigrationPlan({ manifest: manifest(), legacyRoot: root, targetRoot: root });
    const report = applyControlVaultDataMigration({ plan, reportPath });
    assert.equal(report.state, "applied");
    const vaultRoot = path.join(root, "vault-data/tenants/tenant-a/vaults/vault-a");
    assert.equal(fs.readFileSync(path.join(vaultRoot, "workspaces/.polaris/MEMORY.md"), "utf8"), "synthetic memory\n");
    assert.equal(fs.existsSync(path.join(vaultRoot, "backups")), true);
    assert.equal(fs.existsSync(path.join(vaultRoot, "cache")), true);
    assert.equal(fs.statSync(path.join(root, "control/users")).mode & 0o777, 0o750);
    assert.equal(
      fs.statSync(path.join(root, "control/users/tenant-a/vaults/vault-a/docker.agent.yaml")).mode & 0o777,
      0o640,
    );
    const spec = yaml.load(fs.readFileSync(path.join(root, "control/users/tenant-a/vaults/vault-a/docker.agent.yaml"), "utf8")) as {
      attachments: { "vault-data": { mount_root: string; durable_paths: string[]; source: { export_path: string } } };
    };
    assert.equal(spec.attachments["vault-data"].mount_root, "/vault/workspaces");
    assert.deepEqual(spec.attachments["vault-data"].durable_paths, ["/vault/workspaces", "/vault/backups", "/vault/cache"]);
    assert.equal(spec.attachments["vault-data"].source.export_path, path.join(root, "vault-data"));
    assert.equal(verifyControlVaultDataMigration({ reportPath, targetRoot: root }).entries, 4);
    const rolledBack = rollbackControlVaultDataMigration({ reportPath, targetRoot: root });
    assert.equal(rolledBack.state, "rolled-back");
    assert.equal(fs.existsSync(path.join(root, "control")), false);
    assert.equal(fs.existsSync(path.join(root, "vault-data")), false);
    assert.equal(fs.existsSync(path.join(root, "users")), true);
  });
});

test("control/vault-data accepts an external bind-mounted export root", () => {
  withRoots((root, reportPath) => {
    const externalRoot = path.join(
      os.tmpdir(),
      `polaris-control-vault-export-${process.pid}-${Date.now()}`,
      "vault-data",
    );
    try {
      const plan = createControlVaultDataMigrationPlan({
        manifest: manifest(),
        legacyRoot: root,
        targetRoot: root,
        targetExportRoot: externalRoot,
      });
      const report = applyControlVaultDataMigration({ plan, reportPath });
      assert.equal(report.targetExportRoot, externalRoot);
      const spec = yaml.load(fs.readFileSync(
        path.join(root, "control/users/tenant-a/vaults/vault-a/docker.agent.yaml"),
        "utf8",
      )) as { attachments: { "vault-data": { source: { export_path: string } } } };
      assert.equal(spec.attachments["vault-data"].source.export_path, externalRoot);
      assert.equal(verifyControlVaultDataMigration({ reportPath, targetRoot: root }).rewrites, 1);
    } finally {
      fs.rmSync(path.dirname(externalRoot), { recursive: true, force: true });
    }
  });
});

test("control/vault-data CLI accepts the pnpm argument separator", () => {
  withRoots((root, reportPath) => {
    const manifestPath = path.join(os.tmpdir(), `polaris-control-vault-manifest-${process.pid}-${Date.now()}.json`);
    try {
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest(), null, 2)}\n`, { mode: 0o600 });
      const report = runControlVaultDataMigrationCli([
        "--",
        "--manifest", manifestPath,
        "--data-root", root,
        "--report", reportPath,
      ]) as { state: string };
      assert.equal(report.state, "planned");
    } finally {
      fs.rmSync(manifestPath, { force: true });
    }
  });
});

test("control/vault-data migration rejects unlisted data and symlinks", () => {
  withRoots((root) => {
    fs.writeFileSync(path.join(root, "exports/vaults/tenants/unlisted.sqlite"), "unlisted\n");
    assert.throws(
      () => createControlVaultDataMigrationPlan({ manifest: manifest(), legacyRoot: root, targetRoot: root }),
      /Unlisted migration source data/,
    );
  });
  withRoots((root) => {
    fs.symlinkSync(path.join(root, "state/control.sqlite"), path.join(root, "state/linked.sqlite"));
    assert.throws(
      () => createControlVaultDataMigrationPlan({ manifest: manifest(), legacyRoot: root, targetRoot: root }),
      /symbolic link/,
    );
  });
});

test("control/vault-data rollback refuses changed targets", () => {
  withRoots((root, reportPath) => {
    const plan = createControlVaultDataMigrationPlan({ manifest: manifest(), legacyRoot: root, targetRoot: root });
    applyControlVaultDataMigration({ plan, reportPath });
    fs.writeFileSync(path.join(root, "vault-data/tenants/tenant-a/vaults/vault-a/workspaces/.polaris/MEMORY.md"), "changed\n");
    assert.throws(
      () => rollbackControlVaultDataMigration({ reportPath, targetRoot: root }),
      /Refusing to roll back changed target/,
    );
  });
});
