import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROFILE_DIRECTORY = path.join(ROOT_DIR, "config", "release-profiles");
const PROFILE_ID_PATTERN = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;

function fail(message) {
  throw new Error("Release profile: " + message);
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertRecord(value, label) {
  if (!isRecord(value)) {
    fail(label + " must be an object");
  }
  return value;
}

function assertKnownKeys(value, keys, label) {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) {
      fail(label + " contains unsupported key '" + key + "'");
    }
  }
}

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    fail(label + " must be a non-empty string");
  }
  return value.trim();
}

function requirePositiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    fail(label + " must be a positive integer");
  }
  return value;
}

function requirePositiveNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    fail(label + " must be a positive number");
  }
  return value;
}

function validateTopology(raw) {
  const value = assertRecord(raw, "topology");
  assertKnownKeys(value, ["mode", "controlPlaneReplicas", "gatewayReplicas"], "topology");
  return {
    mode: requireString(value.mode, "topology.mode"),
    controlPlaneReplicas: requirePositiveInteger(
      value.controlPlaneReplicas,
      "topology.controlPlaneReplicas",
    ),
    gatewayReplicas: requirePositiveInteger(value.gatewayReplicas, "topology.gatewayReplicas"),
  };
}

function validateCapacity(raw) {
  const value = assertRecord(raw, "capacity");
  assertKnownKeys(value, ["maxActiveVaults", "jobWorkerConcurrency"], "capacity");
  return {
    maxActiveVaults: requirePositiveInteger(value.maxActiveVaults, "capacity.maxActiveVaults"),
    jobWorkerConcurrency: requirePositiveInteger(
      value.jobWorkerConcurrency,
      "capacity.jobWorkerConcurrency",
    ),
  };
}

function validateResourceBudget(raw) {
  const value = assertRecord(raw, "resourceBudget");
  assertKnownKeys(
    value,
    ["vaultCpuMillicores", "vaultMemoryMiB", "vaultPidLimit", "vaultEphemeralStorageMiB"],
    "resourceBudget",
  );
  return {
    vaultCpuMillicores: requirePositiveInteger(
      value.vaultCpuMillicores,
      "resourceBudget.vaultCpuMillicores",
    ),
    vaultMemoryMiB: requirePositiveInteger(value.vaultMemoryMiB, "resourceBudget.vaultMemoryMiB"),
    vaultPidLimit: requirePositiveInteger(value.vaultPidLimit, "resourceBudget.vaultPidLimit"),
    vaultEphemeralStorageMiB: requirePositiveInteger(
      value.vaultEphemeralStorageMiB,
      "resourceBudget.vaultEphemeralStorageMiB",
    ),
  };
}

function validateQuota(raw) {
  const value = assertRecord(raw, "quota");
  assertKnownKeys(
    value,
    ["activeWorkspaceMiB", "cacheMiB", "runtimeStateMiB", "identityStateMiB", "hotStorageMiB"],
    "quota",
  );
  const quota = {
    activeWorkspaceMiB: requirePositiveInteger(value.activeWorkspaceMiB, "quota.activeWorkspaceMiB"),
    cacheMiB: requirePositiveInteger(value.cacheMiB, "quota.cacheMiB"),
    runtimeStateMiB: requirePositiveInteger(value.runtimeStateMiB, "quota.runtimeStateMiB"),
    identityStateMiB: requirePositiveInteger(value.identityStateMiB, "quota.identityStateMiB"),
    hotStorageMiB: requirePositiveInteger(value.hotStorageMiB, "quota.hotStorageMiB"),
  };
  const accountedMiB = quota.activeWorkspaceMiB
    + quota.cacheMiB
    + quota.runtimeStateMiB
    + quota.identityStateMiB;
  if (quota.hotStorageMiB !== accountedMiB) {
    fail("quota.hotStorageMiB must equal the sum of the other quota categories");
  }
  return quota;
}

function validateSlo(raw) {
  const value = assertRecord(raw, "slo");
  assertKnownKeys(
    value,
    [
      "gatewayLaunchSuccessPercent",
      "readP95Ms",
      "mutationP95Ms",
      "recoverySeconds",
      "max5xxPercent",
    ],
    "slo",
  );
  const slo = {
    gatewayLaunchSuccessPercent: requirePositiveNumber(
      value.gatewayLaunchSuccessPercent,
      "slo.gatewayLaunchSuccessPercent",
    ),
    readP95Ms: requirePositiveInteger(value.readP95Ms, "slo.readP95Ms"),
    mutationP95Ms: requirePositiveInteger(value.mutationP95Ms, "slo.mutationP95Ms"),
    recoverySeconds: requirePositiveInteger(value.recoverySeconds, "slo.recoverySeconds"),
    max5xxPercent: requirePositiveNumber(value.max5xxPercent, "slo.max5xxPercent"),
  };
  if (slo.gatewayLaunchSuccessPercent > 100) {
    fail("slo.gatewayLaunchSuccessPercent must not exceed 100");
  }
  if (slo.max5xxPercent > 100) {
    fail("slo.max5xxPercent must not exceed 100");
  }
  return slo;
}

export function validateReleaseProfile(raw) {
  const value = assertRecord(raw, "profile");
  assertKnownKeys(
    value,
    ["schemaVersion", "id", "topology", "capacity", "resourceBudget", "quota", "slo"],
    "profile",
  );
  if (value.schemaVersion !== 1) {
    fail("schemaVersion must be 1");
  }
  const id = requireString(value.id, "id");
  if (!PROFILE_ID_PATTERN.test(id)) {
    fail("id contains unsupported characters");
  }
  return {
    schemaVersion: 1,
    id,
    topology: validateTopology(value.topology),
    capacity: validateCapacity(value.capacity),
    resourceBudget: validateResourceBudget(value.resourceBudget),
    quota: validateQuota(value.quota),
    slo: validateSlo(value.slo),
  };
}

export function loadReleaseProfile(profileId) {
  const id = requireString(profileId, "profile ID");
  if (!PROFILE_ID_PATTERN.test(id)) {
    fail("profile ID contains unsupported characters");
  }
  const profilePath = path.join(PROFILE_DIRECTORY, id + ".json");
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(profilePath, "utf8"));
  } catch (error) {
    fail("could not read profile '" + id + "': " + (error instanceof Error ? error.message : String(error)));
  }
  const profile = validateReleaseProfile(raw);
  if (profile.id !== id) {
    fail("profile file ID does not match its requested profile ID");
  }
  return profile;
}

function requiredEnvironmentValue(environment, key) {
  const value = String(environment[key] ?? "").trim();
  if (!value) {
    fail(key + " is required when a release profile is enabled");
  }
  return value;
}

function requireEnvironmentInteger(environment, key, expected) {
  const raw = requiredEnvironmentValue(environment, key);
  if (!/^[1-9][0-9]*$/u.test(raw) || Number(raw) !== expected) {
    fail(key + " must equal " + String(expected) + " for the configured release profile");
  }
}

function requireDigestPinnedImage(environment, key) {
  const value = requiredEnvironmentValue(environment, key);
  if (!/^[^\s@]+@sha256:[a-f0-9]{64}$/u.test(value)) {
    fail(key + " must be a digest-pinned image reference for the configured release profile");
  }
  return value;
}

export function validateReleaseProfileEnvironment(profile, environment = process.env) {
  if (profile.id !== "0.3.0-single-host" || profile.topology.mode !== "single-host") {
    fail("only the 0.3.0 single-host release profile is supported");
  }
  if (requiredEnvironmentValue(environment, "POLARIS_RELEASE_PROFILE") !== profile.id) {
    fail("POLARIS_RELEASE_PROFILE does not match the configured profile");
  }
  if (requiredEnvironmentValue(environment, "POLARIS_DEPLOYMENT_MODE") !== profile.topology.mode) {
    fail("POLARIS_DEPLOYMENT_MODE must be single-host for the configured release profile");
  }
  requireEnvironmentInteger(
    environment,
    "POLARIS_SERVER_REPLICAS",
    profile.topology.controlPlaneReplicas,
  );
  requireEnvironmentInteger(
    environment,
    "POLARIS_GATEWAY_REPLICAS",
    profile.topology.gatewayReplicas,
  );
  requireEnvironmentInteger(
    environment,
    "POLARIS_JOB_WORKER_CONCURRENCY",
    profile.capacity.jobWorkerConcurrency,
  );
  requireEnvironmentInteger(
    environment,
    "POLARIS_MAX_ACTIVE_VAULTS",
    profile.capacity.maxActiveVaults,
  );
  requireEnvironmentInteger(
    environment,
    "POLARIS_ACTIVE_WORKSPACE_QUOTA_BYTES",
    profile.quota.activeWorkspaceMiB * 1024 * 1024,
  );
  requireDigestPinnedImage(environment, "POLARIS_WANGHAI_VAULT_IMAGE");
  return profile;
}

export function loadConfiguredReleaseProfile(environment = process.env) {
  const profileId = requiredEnvironmentValue(environment, "POLARIS_RELEASE_PROFILE");
  const profile = loadReleaseProfile(profileId);
  return validateReleaseProfileEnvironment(profile, environment);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const profile = loadConfiguredReleaseProfile();
    process.stdout.write("release profile: ok (" + profile.id + ")\n");
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
    process.exitCode = 1;
  }
}
