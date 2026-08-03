import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCreatedHostSurfaceHref,
  DEFAULT_POLARIS_VAULT_PATH,
  HOST_NAME_VALIDATION_MESSAGE,
  isValidPolarisHostName,
  resolveCodingSurfaceUrl,
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
    buildCreatedHostSurfaceHref("srv_demo", "coding"),
    "/v/srv_demo/coding",
  );
});

test("buildCreatedHostSurfaceHref targets the Wanghai embed route for vertical hosts", () => {
  assert.equal(
    buildCreatedHostSurfaceHref("srv_demo", "vertical"),
    "/v/srv_demo/wanghai",
  );
});

test("resolveCodingSurfaceUrl prefers the configured Paseo app base URL", () => {
  assert.equal(
    resolveCodingSurfaceUrl({
      href: "/v/srv_demo/coding",
      paseoAppBaseUrl: "http://128.178.122.228:8082",
      currentOrigin: "http://128.178.122.228:8787",
    }),
    "http://128.178.122.228:8082/h/srv_demo",
  );
});

test("resolveCodingSurfaceUrl falls back to the current origin", () => {
  assert.equal(
    resolveCodingSurfaceUrl({
      href: "/v/srv_demo/coding",
      paseoAppBaseUrl: "",
      currentOrigin: "http://128.178.122.228:8787",
    }),
    "http://128.178.122.228:8787/h/srv_demo",
  );
});

test("resolveCodingSurfaceUrl preserves reconnect scope and offer on the current gateway origin", () => {
  assert.equal(
    resolveCodingSurfaceUrl({
      href: "/v/srv_demo/coding",
      paseoAppBaseUrl: "https://polaris.example/paseo",
      currentOrigin: "http://m00e04c1b76c0.dyn.epfl.ch",
      reconnectTarget:
        "https://polaris.example/paseo/h/srv_demo?scope=user%3Ademo#offer=opaque-offer",
    }),
    "http://m00e04c1b76c0.dyn.epfl.ch/h/srv_demo?scope=user%3Ademo#offer=opaque-offer",
  );
});

test("resolveCodingSurfaceUrl keeps the dedicated same-host Paseo port when reconnecting locally", () => {
  assert.equal(
    resolveCodingSurfaceUrl({
      href: "/v/srv_demo/coding",
      paseoAppBaseUrl: "http://127.0.0.1:8082",
      currentOrigin: "http://127.0.0.1:8787",
      reconnectTarget:
        "http://127.0.0.1:8082/h/srv_demo?scope=user%3Ademo#offer=opaque-offer",
    }),
    "http://127.0.0.1:8082/h/srv_demo?scope=user%3Ademo#offer=opaque-offer",
  );
});

test("default vault path is the new shell label", () => {
  assert.equal(DEFAULT_POLARIS_VAULT_PATH, "/root/vault");
});
