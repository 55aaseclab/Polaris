import assert from "node:assert/strict";
import test from "node:test";
import {
  loadConfiguredReleaseProfile,
  loadReleaseProfile,
  validateReleaseProfile,
  validateReleaseProfileEnvironment,
} from "../release-profile.mjs";

function releaseEnvironment(profile) {
  return {
    POLARIS_RELEASE_PROFILE: profile.id,
    POLARIS_DEPLOYMENT_MODE: profile.topology.mode,
    POLARIS_SERVER_REPLICAS: String(profile.topology.controlPlaneReplicas),
    POLARIS_GATEWAY_REPLICAS: String(profile.topology.gatewayReplicas),
    POLARIS_JOB_WORKER_CONCURRENCY: String(profile.capacity.jobWorkerConcurrency),
    POLARIS_MAX_ACTIVE_VAULTS: String(profile.capacity.maxActiveVaults),
    POLARIS_ACTIVE_WORKSPACE_QUOTA_BYTES: String(profile.quota.activeWorkspaceMiB * 1024 * 1024),
  };
}

test("the 0.3.0 single-host profile declares bounded capacity and quota defaults", () => {
  const profile = loadReleaseProfile("0.3.0-single-host");
  assert.equal(profile.topology.mode, "single-host");
  assert.equal(profile.topology.controlPlaneReplicas, 1);
  assert.equal(profile.topology.gatewayReplicas, 1);
  assert.equal(profile.capacity.maxActiveVaults, 10);
  assert.equal(profile.capacity.jobWorkerConcurrency, 1);
  assert.equal(profile.quota.hotStorageMiB, 512);
  assert.equal(profile.slo.readP95Ms, 500);
});

test("release profile validation rejects inconsistent storage accounting", () => {
  const profile = loadReleaseProfile("0.3.0-single-host");
  const invalid = JSON.parse(JSON.stringify(profile));
  invalid.quota.hotStorageMiB = 513;
  assert.throws(
    () => validateReleaseProfile(invalid),
    /hotStorageMiB must equal the sum/i,
  );
});

test("the single-host profile rejects replicas and mismatched capacity overrides", () => {
  const profile = loadReleaseProfile("0.3.0-single-host");
  const environment = releaseEnvironment(profile);
  assert.doesNotThrow(() => validateReleaseProfileEnvironment(profile, environment));

  environment.POLARIS_SERVER_REPLICAS = "2";
  assert.throws(
    () => validateReleaseProfileEnvironment(profile, environment),
    /POLARIS_SERVER_REPLICAS must equal 1/i,
  );

  environment.POLARIS_SERVER_REPLICAS = "1";
  environment.POLARIS_MAX_ACTIVE_VAULTS = "11";
  assert.throws(
    () => validateReleaseProfileEnvironment(profile, environment),
    /POLARIS_MAX_ACTIVE_VAULTS must equal 10/i,
  );

  environment.POLARIS_MAX_ACTIVE_VAULTS = "10";
  environment.POLARIS_ACTIVE_WORKSPACE_QUOTA_BYTES = "1";
  assert.throws(
    () => validateReleaseProfileEnvironment(profile, environment),
    /POLARIS_ACTIVE_WORKSPACE_QUOTA_BYTES must equal 268435456/i,
  );
});

test("a configured release profile requires every single-host control value", () => {
  const profile = loadReleaseProfile("0.3.0-single-host");
  const environment = releaseEnvironment(profile);
  delete environment.POLARIS_GATEWAY_REPLICAS;
  assert.throws(
    () => loadConfiguredReleaseProfile(environment),
    /POLARIS_GATEWAY_REPLICAS is required/i,
  );
});
