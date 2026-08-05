import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  loadReleaseManifest,
  validateReleaseManifest,
  validateReleaseManifestEnvironment,
} from "../release-manifest.mjs";

const digest = "a".repeat(64);

function validManifest(environmentSha256 = digest) {
  return {
    schemaVersion: 1,
    release: "0.3.0",
    profile: "0.3.0-single-host",
    polarisSourceCommit: "a19f9ed",
    workspaceBaseImage: `registry.example.test/polaris-base@sha256:${digest}`,
    wanghaiImage: `registry.example.test/wanghai@sha256:${"b".repeat(64)}`,
    environmentSha256,
    migration: "none",
    evidence: ["synthetic-gateway", "capacity-2-5-10"],
    previousManifestSha256: "c".repeat(64),
    generatedAt: "2026-08-05T12:00:00Z",
  };
}

test("release manifest accepts the complete immutable candidate", () => {
  assert.equal(validateReleaseManifest(validManifest()).release, "0.3.0");
});

test("release manifest rejects mutable images and missing rollback reference", () => {
  assert.throws(
    () => validateReleaseManifest({ ...validManifest(), wanghaiImage: "wanghai:latest" }),
    /wanghaiImage has an invalid format/u,
  );
  assert.throws(
    () => validateReleaseManifest({ ...validManifest(), previousManifestSha256: "" }),
    /previousManifestSha256 must be a non-empty string/u,
  );
});

test("release manifest binds image and profile values to the environment hash", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-release-manifest-"));
  const envPath = path.join(root, "polaris.env");
  const env = [
    "POLARIS_RELEASE_PROFILE=0.3.0-single-host",
    `POLARIS_WORKSPACE_BASE_IMAGE=registry.example.test/polaris-base@sha256:${digest}`,
    `POLARIS_WANGHAI_VAULT_IMAGE=registry.example.test/wanghai@sha256:${"b".repeat(64)}`,
  ].join("\n") + "\n";
  fs.writeFileSync(envPath, env);
  const environmentSha256 = crypto.createHash("sha256").update(env).digest("hex");
  const manifest = validManifest(environmentSha256);
  try {
    assert.doesNotThrow(() => validateReleaseManifestEnvironment(manifest, {
      POLARIS_RELEASE_PROFILE: manifest.profile,
      POLARIS_WORKSPACE_BASE_IMAGE: manifest.workspaceBaseImage,
      POLARIS_WANGHAI_VAULT_IMAGE: manifest.wanghaiImage,
    }, envPath));
    fs.appendFileSync(envPath, "POLARIS_SERVER_REPLICAS=2\n");
    assert.throws(
      () => validateReleaseManifestEnvironment(manifest, {
        POLARIS_RELEASE_PROFILE: manifest.profile,
        POLARIS_WORKSPACE_BASE_IMAGE: manifest.workspaceBaseImage,
        POLARIS_WANGHAI_VAULT_IMAGE: manifest.wanghaiImage,
      }, envPath),
      /environment hash does not match/u,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("release manifest loader rejects a symlink", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-release-manifest-link-"));
  const target = path.join(root, "manifest.json");
  const link = path.join(root, "link.json");
  fs.writeFileSync(target, JSON.stringify(validManifest()));
  fs.symlinkSync(target, link);
  try {
    assert.throws(() => loadReleaseManifest(link), /regular non-symlink/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
