import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateReleaseManifest } from "./release-manifest.mjs";

function fail(message) {
  throw new Error("Create release manifest: " + message);
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith("--") || !argv[index + 1]) fail("invalid arguments");
    values[flag.slice(2)] = argv[index + 1];
    index += 1;
  }
  return values;
}

function readEnvironment(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const values = {};
  for (const line of text.split(/\r?\n/u)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/u);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith("\"") && value.endsWith("\""))
      || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return { text, values };
}

function required(values, key) {
  const value = String(values[key] ?? "").trim();
  if (!value) fail(`${key} is required in the environment file`);
  return value;
}

export function createReleaseManifest({
  environmentFile,
  outputFile,
  sourceCommit,
  previousManifestSha256,
  evidence,
  migration = "none",
  generatedAt = new Date().toISOString(),
}) {
  const environmentPath = path.resolve(environmentFile);
  const outputPath = path.resolve(outputFile);
  const { text, values } = readEnvironment(environmentPath);
  const manifest = validateReleaseManifest({
    schemaVersion: 1,
    release: "0.3.0",
    profile: required(values, "POLARIS_RELEASE_PROFILE"),
    polarisSourceCommit: sourceCommit,
    workspaceBaseImage: required(values, "POLARIS_WORKSPACE_BASE_IMAGE"),
    wanghaiImage: required(values, "POLARIS_WANGHAI_VAULT_IMAGE"),
    environmentSha256: crypto.createHash("sha256").update(text).digest("hex"),
    migration,
    evidence,
    previousManifestSha256,
    generatedAt,
  });
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryPath, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o644 });
  fs.renameSync(temporaryPath, outputPath);
  return { path: outputPath, manifest };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const evidence = String(args.evidence ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    if (evidence.length === 0) fail("--evidence requires at least one comma-separated reference");
    if (!args["env-file"] || !args.output || !args["source-commit"] || !args["previous-manifest-sha256"]) {
      fail("usage: --env-file <file> --output <file> --source-commit <sha> "
        + "--previous-manifest-sha256 <sha256> --evidence <a,b>");
    }
    const result = createReleaseManifest({
      environmentFile: args["env-file"],
      outputFile: args.output,
      sourceCommit: args["source-commit"],
      previousManifestSha256: args["previous-manifest-sha256"],
      evidence,
      migration: args.migration ?? "none",
    });
    process.stdout.write(`created ${result.path}\n`);
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
    process.exitCode = 1;
  }
}
