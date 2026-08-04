import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { VaultSpec } from "../scripts/core/vault.js";
import { writeGeneratedManifest } from "../scripts/output/write-generated.js";

const vault = {
  backend: { kind: "docker" },
  identity: { projectName: "synthetic-vault" },
  userProfile: { id: "synthetic-user" },
} as VaultSpec;

test("generated manifests containing gateway secrets are owner-readable only", () => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-generated-output-"));
  const previousDataRoot = process.env.POLARIS_DATA_ROOT;
  process.env.POLARIS_DATA_ROOT = dataRoot;
  try {
    const outputPath = writeGeneratedManifest(vault, "gateway-secret: synthetic\n");
    assert.equal(fs.statSync(path.dirname(outputPath)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(outputPath).mode & 0o777, 0o600);

    fs.chmodSync(outputPath, 0o644);
    writeGeneratedManifest(vault, "gateway-secret: rotated\n");
    assert.equal(fs.statSync(outputPath).mode & 0o777, 0o600);
  } finally {
    if (previousDataRoot === undefined) delete process.env.POLARIS_DATA_ROOT;
    else process.env.POLARIS_DATA_ROOT = previousDataRoot;
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
