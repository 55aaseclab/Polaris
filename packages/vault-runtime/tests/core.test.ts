import test from "node:test";
import assert from "node:assert/strict";
import {
  authFileStorageTarget,
  stateStoragePathForMountPath,
  userIdentityBootstrapDirs,
} from "../src/core/identity-layout.js";
import {
  dockerNetfsDevicePath,
  dockerNetfsServer,
  netfsMountOptions,
  netfsResolvedPath,
  vaultDataClaimName,
} from "../src/core/netfs.js";
import {
  assertValidProjectName,
  isValidProjectName,
  vaultRuntimeResourceName,
  vaultRuntimeScopeName,
} from "../src/core/vault-name.js";
import { createRuntimeSpec } from "./fixtures.js";

test("runtime names stay deterministic and bounded", () => {
  const scope = vaultRuntimeScopeName("tenant-a", "synthetic-vault");
  assert.equal(scope, "tenant-a-synthetic-vault");
  assert.equal(
    vaultRuntimeResourceName("tenant-a", "synthetic-vault", "vm"),
    "tenant-a-synthetic-vault-vm",
  );

  const longScope = vaultRuntimeScopeName("tenant/with spaces", "a".repeat(80));
  assert.ok(longScope.length <= 63);
  assert.equal(longScope, vaultRuntimeScopeName("tenant/with spaces", "a".repeat(80)));
});

test("project names enforce the runtime naming contract", () => {
  assert.equal(isValidProjectName("synthetic-vault-1"), true);
  assert.equal(isValidProjectName("Synthetic Vault"), false);
  assert.doesNotThrow(() => assertValidProjectName("synthetic-vault"));
  assert.throws(() => assertValidProjectName("-invalid"), /Vault name/);
});

test("identity layout maps harness state into the user attachment", () => {
  assert.equal(
    stateStoragePathForMountPath({
      mountPath: "/root/.codex/auth.json",
      runtimeHome: "/root",
      identityRoot: "/identity",
    }),
    "/identity/codex/auth.json",
  );
  assert.equal(
    authFileStorageTarget(
      { key: "other", mountPath: "/etc/other.conf" },
      { runtimeHome: "/root", identityRoot: "/identity" },
    ),
    "/etc/other.conf",
  );
  assert.ok(userIdentityBootstrapDirs("/identity").includes("/identity/ssh"));
});

test("netfs helpers preserve server, export, and subpath semantics", () => {
  const source = {
    kind: "netfs" as const,
    server: "netfs.example.test",
    exportPath: "/exports/vaults",
    subPath: "/tenant-a/synthetic-vault/",
  };
  assert.equal(netfsResolvedPath(source), "/exports/vaults/tenant-a/synthetic-vault");
  assert.equal(dockerNetfsServer(source), "netfs.example.test");
  assert.equal(dockerNetfsDevicePath(source), ":/exports/vaults/tenant-a/synthetic-vault");
  assert.deepEqual(netfsMountOptions(source), ["nfsvers=4.1", "hard", "rw"]);

  const spec = createRuntimeSpec();
  spec.attachments.vaultData.source = source;
  assert.equal(vaultDataClaimName(spec), "tenant-a-synthetic-vault-vault-data");
});
