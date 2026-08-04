import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, "utf8");
  fs.chmodSync(filePath, 0o755);
}

function withPreflightFixture({
  publicPort = false,
  psFailure = false,
  dnsFailure = false,
  tlsFailure = false,
  envOverrides = {},
}, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "polaris-release-preflight-"));
  const bin = path.join(root, "bin");
  const envFile = path.join(root, "polaris.env");
  fs.mkdirSync(bin);
  const digest = "a".repeat(64);
  const values = {
    POLARIS_RELEASE_PROFILE: "0.3.0-single-host",
    POLARIS_DEPLOYMENT_MODE: "single-host",
    POLARIS_SERVER_REPLICAS: "1",
    POLARIS_GATEWAY_REPLICAS: "1",
    POLARIS_JOB_WORKER_CONCURRENCY: "1",
    POLARIS_MAX_ACTIVE_VAULTS: "10",
    POLARIS_AUTH_MODE: "authing-browser-session",
    POLARIS_AUTHING_APP_ID: "synthetic-app-id",
    POLARIS_AUTHING_APP_SECRET: "synthetic-app-secret",
    POLARIS_AUTHING_ISSUER: "https://auth.example.test/oidc",
    POLARIS_AUTHING_AUTHORIZATION_URL: "https://auth.example.test/oidc/auth",
    POLARIS_AUTHING_TOKEN_URL: "https://auth.example.test/oidc/token",
    POLARIS_AUTHING_LOGOUT_URL: "https://auth.example.test/oidc/session/end",
    POLARIS_AUTHING_LOGOUT_REDIRECT_URI: "https://polaris.example.test/welcome",
    POLARIS_AUTHING_REDIRECT_URI: "https://polaris.example.test/auth/callback",
    POLARIS_WANGHAI_GATEWAY_ORIGIN: "https://gateway.example.test",
    POLARIS_WANGHAI_GATEWAY_MASTER_SECRET: "0123456789abcdef0123456789abcdef",
    POLARIS_PORTAL_ALLOWED_ORIGINS: "https://polaris.example.test",
    POLARIS_WANGHAI_VAULT_IMAGE: "registry.example.test/wanghai@sha256:" + digest,
  };
  Object.assign(values, envOverrides);
  fs.writeFileSync(
    envFile,
    Object.entries(values).map(([key, value]) => key + "=" + value).join("\n") + "\n",
  );
  writeExecutable(path.join(bin, "docker"), `#!/usr/bin/env bash
if [ "$1" = "image" ] && [ "$2" = "inspect" ]; then exit 0; fi
if [ "$1" = "ps" ]; then ${psFailure ? "exit 1" : publicPort ? "printf '%s\\n' 'legacy 0.0.0.0:32002->9090/tcp'; exit 0" : "exit 0"}; fi
exit 1
`);
  writeExecutable(path.join(bin, "getent"), "#!/usr/bin/env bash\nexit " + (dnsFailure ? 1 : 0) + "\n");
  writeExecutable(path.join(bin, "curl"), "#!/usr/bin/env bash\nexit " + (tlsFailure ? 1 : 0) + "\n");
  try {
    run({ bin, envFile });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function runPreflight(bin, envFile) {
  return spawnSync("bash", ["scripts/release-preflight.sh", envFile], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, PATH: bin + ":" + process.env.PATH },
  });
}

test("release preflight accepts a private, digest-pinned gateway candidate", () => {
  withPreflightFixture({}, ({ bin, envFile }) => {
    const result = spawnSync("bash", ["scripts/release-preflight.sh", envFile], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /release preflight: ok/);
  });
});

test("release preflight rejects a public Wanghai Docker port", () => {
  withPreflightFixture({ publicPort: true }, ({ bin, envFile }) => {
    const result = spawnSync("bash", ["scripts/release-preflight.sh", envFile], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /public Docker mapping to Wanghai port 9090/);
  });
});

test("release preflight fails closed when Docker port inspection fails", () => {
  withPreflightFixture({ psFailure: true }, ({ bin, envFile }) => {
    const result = spawnSync("bash", ["scripts/release-preflight.sh", envFile], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unable to inspect Docker port mappings/);
  });
});

test("release preflight rejects disabled authentication", () => {
  withPreflightFixture({ envOverrides: { POLARIS_AUTH_MODE: "disabled" } }, ({ bin, envFile }) => {
    const result = runPreflight(bin, envFile);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /POLARIS_AUTH_MODE must be authing-browser-session/);
  });
});

test("release preflight rejects replica mode", () => {
  withPreflightFixture({
    envOverrides: { POLARIS_SERVER_REPLICAS: "2" },
  }, ({ bin, envFile }) => {
    const result = runPreflight(bin, envFile);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /POLARIS_SERVER_REPLICAS must equal 1/);
  });
});

test("release preflight rejects malformed Authing configuration", () => {
  withPreflightFixture({
    envOverrides: { POLARIS_AUTHING_ISSUER: "http://auth.example.test/oidc" },
  }, ({ bin, envFile }) => {
    const result = runPreflight(bin, envFile);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /POLARIS_AUTHING_ISSUER must be a valid HTTPS URL/);
  });
});

test("release preflight rejects malformed gateway origins", () => {
  withPreflightFixture({
    envOverrides: { POLARIS_WANGHAI_GATEWAY_ORIGIN: "http://gateway.example.test" },
  }, ({ bin, envFile }) => {
    const result = runPreflight(bin, envFile);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /POLARIS_WANGHAI_GATEWAY_ORIGIN must be a bare HTTPS origin/);
  });
});

test("release preflight rejects mutable Wanghai images", () => {
  withPreflightFixture({
    envOverrides: { POLARIS_WANGHAI_VAULT_IMAGE: "registry.example.test/wanghai:latest" },
  }, ({ bin, envFile }) => {
    const result = runPreflight(bin, envFile);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /digest-pinned image reference/);
  });
});

test("release preflight rejects wildcard DNS failures", () => {
  withPreflightFixture({ dnsFailure: true }, ({ bin, envFile }) => {
    const result = runPreflight(bin, envFile);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /wildcard DNS does not resolve/);
  });
});

test("release preflight rejects wildcard TLS failures", () => {
  withPreflightFixture({ tlsFailure: true }, ({ bin, envFile }) => {
    const result = runPreflight(bin, envFile);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /wildcard TLS endpoint is not reachable/);
  });
});
