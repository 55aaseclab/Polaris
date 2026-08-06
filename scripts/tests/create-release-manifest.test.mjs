import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createReleaseManifest } from "../create-release-manifest.mjs";
import { loadReleaseManifest } from "../release-manifest.mjs";

test("create release manifest binds the exact environment and candidate inputs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-create-manifest-"));
  const envPath = path.join(root, "polaris.env");
  const outputPath = path.join(root, "deploy", "release-manifest.json");
  const base = `registry.example.test/base@sha256:${"a".repeat(64)}`;
  const image = `registry.example.test/wanghai@sha256:${"b".repeat(64)}`;
  const text = [
    "POLARIS_RELEASE_ID=0.3.1",
    "POLARIS_RELEASE_PROFILE=0.3.0-single-host",
    `POLARIS_WORKSPACE_BASE_IMAGE=${base}`,
    `POLARIS_WANGHAI_VAULT_IMAGE=${image}`,
    "POLARIS_RELEASE_MANIFEST=deploy/release-manifest.json",
    "",
  ].join("\n");
  fs.writeFileSync(envPath, text);
  try {
    const result = createReleaseManifest({
      environmentFile: envPath,
      outputFile: outputPath,
      sourceCommit: "a19f9ed",
      previousManifestSha256: "c".repeat(64),
      evidence: ["synthetic-gateway"],
      generatedAt: "2026-08-05T12:00:00Z",
    });
    const loaded = loadReleaseManifest(outputPath).manifest;
    assert.equal(loaded.release, "0.3.1");
    assert.equal(loaded.wanghaiImage, image);
    assert.equal(
      loaded.environmentSha256,
      crypto.createHash("sha256").update(text).digest("hex"),
    );
    assert.equal(result.path, outputPath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
