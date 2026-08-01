import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCreatedHostSurfaceHref,
  HOST_NAME_VALIDATION_MESSAGE,
  isValidPolarisHostName,
  validatePolarisHostName,
} from "./create-host.js";

test("host name validation matches the Polaris create-host modal rules", () => {
  assert.equal(isValidPolarisHostName("demo"), true);
  assert.equal(isValidPolarisHostName("demo-01"), true);
  assert.equal(isValidPolarisHostName("1demo"), true);
  assert.equal(isValidPolarisHostName("demo-"), false);
  assert.equal(isValidPolarisHostName("-demo"), false);
  assert.equal(isValidPolarisHostName("DEMO"), false);
  assert.equal(isValidPolarisHostName("1234"), false);
});

test("validatePolarisHostName returns the shared message for invalid names", () => {
  assert.deepEqual(validatePolarisHostName(""), { hostName: "", error: null });
  assert.deepEqual(validatePolarisHostName("demo"), { hostName: "demo", error: null });
  assert.deepEqual(validatePolarisHostName("bad_name"), {
    hostName: "bad_name",
    error: HOST_NAME_VALIDATION_MESSAGE,
  });
});

test("buildCreatedHostSurfaceHref targets the Paseo surface root", () => {
  assert.equal(
    buildCreatedHostSurfaceHref("srv_demo"),
    "/h/srv_demo",
  );
});
