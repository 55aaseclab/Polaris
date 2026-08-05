import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const IMAGE_REF_PATTERN = /^[^\s@]+@sha256:[a-f0-9]{64}$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{7,64}$/u;
const RELEASE_ID = "0.3.0";
const PROFILE_ID = "0.3.0-single-host";
export const INITIAL_PREVIOUS_MANIFEST_SHA256 = "0".repeat(64);

function fail(message) {
  throw new Error("Release manifest: " + message);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertRecord(value, label) {
  if (!isRecord(value)) fail(label + " must be an object");
  return value;
}

function assertKnownKeys(value, keys, label) {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) fail(label + " contains unsupported key '" + key + "'");
  }
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) fail(label + " must be a non-empty string");
  return value.trim();
}

function requiredPattern(value, pattern, label) {
  const normalized = requiredString(value, label);
  if (!pattern.test(normalized)) fail(label + " has an invalid format");
  return normalized;
}

function requiredStringList(value, label) {
  if (!Array.isArray(value) || value.length === 0) fail(label + " must be a non-empty list");
  return value.map((entry, index) => requiredString(entry, `${label}[${index}]`));
}

export function validateReleaseManifest(raw) {
  const value = assertRecord(raw, "manifest");
  assertKnownKeys(
    value,
    [
      "schemaVersion",
      "release",
      "profile",
      "polarisSourceCommit",
      "workspaceBaseImage",
      "wanghaiImage",
      "environmentSha256",
      "migration",
      "evidence",
      "previousManifestSha256",
      "generatedAt",
    ],
    "manifest",
  );
  if (value.schemaVersion !== 1) fail("schemaVersion must be 1");
  if (requiredString(value.release, "release") !== RELEASE_ID) {
    fail(`release must be ${RELEASE_ID}`);
  }
  if (requiredString(value.profile, "profile") !== PROFILE_ID) {
    fail(`profile must be ${PROFILE_ID}`);
  }
  const generatedAt = requiredString(value.generatedAt, "generatedAt");
  if (!Number.isFinite(Date.parse(generatedAt))) fail("generatedAt must be an ISO timestamp");

  const migration = requiredString(value.migration, "migration");
  const previousManifestSha256 = requiredPattern(
    value.previousManifestSha256,
    DIGEST_PATTERN,
    "previousManifestSha256",
  );
  if (migration === "initial" && previousManifestSha256 !== INITIAL_PREVIOUS_MANIFEST_SHA256) {
    fail("initial migration must use the genesis previousManifestSha256");
  }
  if (migration !== "initial" && previousManifestSha256 === INITIAL_PREVIOUS_MANIFEST_SHA256) {
    fail("only initial migration may use the genesis previousManifestSha256");
  }

  return {
    schemaVersion: 1,
    release: RELEASE_ID,
    profile: PROFILE_ID,
    polarisSourceCommit: requiredPattern(value.polarisSourceCommit, COMMIT_PATTERN, "polarisSourceCommit"),
    workspaceBaseImage: requiredPattern(value.workspaceBaseImage, IMAGE_REF_PATTERN, "workspaceBaseImage"),
    wanghaiImage: requiredPattern(value.wanghaiImage, IMAGE_REF_PATTERN, "wanghaiImage"),
    environmentSha256: requiredPattern(value.environmentSha256, DIGEST_PATTERN, "environmentSha256"),
    migration,
    evidence: requiredStringList(value.evidence, "evidence"),
    previousManifestSha256,
    generatedAt,
  };
}

export function loadReleaseManifest(manifestPath) {
  const normalizedPath = path.resolve(requiredString(manifestPath, "manifest path"));
  let stats;
  try {
    stats = fs.lstatSync(normalizedPath);
  } catch {
    fail("manifest file is unavailable");
  }
  if (!stats.isFile() || stats.isSymbolicLink()) fail("manifest must be a regular non-symlink file");
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(normalizedPath, "utf8"));
  } catch (error) {
    fail("manifest JSON is invalid: " + (error instanceof Error ? error.message : String(error)));
  }
  return { path: normalizedPath, manifest: validateReleaseManifest(raw) };
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

export function validateReleaseManifestEnvironment(manifest, environment, envFilePath) {
  if (String(environment.POLARIS_RELEASE_PROFILE ?? "").trim() !== manifest.profile) {
    fail("manifest profile does not match POLARIS_RELEASE_PROFILE");
  }
  if (String(environment.POLARIS_WANGHAI_VAULT_IMAGE ?? "").trim() !== manifest.wanghaiImage) {
    fail("manifest Wanghai image does not match POLARIS_WANGHAI_VAULT_IMAGE");
  }
  if (String(environment.POLARIS_WORKSPACE_BASE_IMAGE ?? "").trim() !== manifest.workspaceBaseImage) {
    fail("manifest workspace base does not match POLARIS_WORKSPACE_BASE_IMAGE");
  }
  const actualEnvironmentSha256 = sha256File(envFilePath);
  if (actualEnvironmentSha256 !== manifest.environmentSha256) {
    fail("manifest environment hash does not match the deployed environment file");
  }
  return manifest;
}

export function validateConfiguredReleaseManifest(environment, envFilePath) {
  const manifestPath = requiredString(environment.POLARIS_RELEASE_MANIFEST, "POLARIS_RELEASE_MANIFEST");
  const loaded = loadReleaseManifest(manifestPath);
  return validateReleaseManifestEnvironment(loaded.manifest, environment, envFilePath);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const envFilePath = process.argv[2];
    if (!envFilePath) fail("usage: release-manifest.mjs <environment-file>");
    const manifest = validateConfiguredReleaseManifest(process.env, envFilePath);
    process.stdout.write(`release manifest: ok (${manifest.release})\n`);
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
    process.exitCode = 1;
  }
}
