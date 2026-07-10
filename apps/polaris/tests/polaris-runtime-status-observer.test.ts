import test from "node:test";
import assert from "node:assert/strict";
import {
  isTransientExecutorDisconnect,
} from "../scripts/runtime/status-observer.mjs";

test("status observer treats stop-boundary executor disconnects as transient", () => {
  assert.equal(
    isTransientExecutorDisconnect(new Error("other side closed")),
    true,
  );
  assert.equal(
    isTransientExecutorDisconnect(new Error("fetch failed")),
    true,
  );
  assert.equal(
    isTransientExecutorDisconnect(new Error("read ECONNRESET")),
    true,
  );
  assert.equal(
    isTransientExecutorDisconnect(new Error("connect ECONNREFUSED 127.0.0.1:8788")),
    true,
  );
  assert.equal(
    isTransientExecutorDisconnect(new Error("status report failed: 500 Internal Server Error")),
    false,
  );
});

test("status observer reports only workspace lifecycle status", async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.POLARIS_RUNTIME_STATUS_REPORT_URL;
  const originalSecret = process.env.POLARIS_RUNTIME_STATUS_REPORT_SECRET;
  const originalBackend = process.env.POLARIS_DRIVER_BACKEND;
  const originalProfile = process.env.POLARIS_DRIVER_PROFILE;
  const payloads: Array<Record<string, unknown>> = [];
  process.env.POLARIS_RUNTIME_STATUS_REPORT_URL = "http://executor.test/workspaces/status/report";
  process.env.POLARIS_RUNTIME_STATUS_REPORT_SECRET = "secret";
  process.env.POLARIS_DRIVER_BACKEND = "docker";
  process.env.POLARIS_DRIVER_PROFILE = "";
  globalThis.fetch = async (_input, init) => {
    payloads.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
    return new Response(null, { status: 200 });
  };
  try {
    const { reportRuntimeStatus } = await import(
      `../scripts/runtime/status-observer.mjs?case=${Date.now()}`
    );
    await reportRuntimeStatus();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) {
      delete process.env.POLARIS_RUNTIME_STATUS_REPORT_URL;
    } else {
      process.env.POLARIS_RUNTIME_STATUS_REPORT_URL = originalUrl;
    }
    if (originalSecret === undefined) {
      delete process.env.POLARIS_RUNTIME_STATUS_REPORT_SECRET;
    } else {
      process.env.POLARIS_RUNTIME_STATUS_REPORT_SECRET = originalSecret;
    }
    if (originalBackend === undefined) {
      delete process.env.POLARIS_DRIVER_BACKEND;
    } else {
      process.env.POLARIS_DRIVER_BACKEND = originalBackend;
    }
    if (originalProfile === undefined) {
      delete process.env.POLARIS_DRIVER_PROFILE;
    } else {
      process.env.POLARIS_DRIVER_PROFILE = originalProfile;
    }
  }
  assert.equal(payloads.length, 1);
  assert.equal("paseo" in payloads[0], false);
  assert.deepEqual(payloads[0].status, {
    driver: {
      selected: {
        backend: "docker",
      },
      status: "running",
      reason: "runtime status observer heartbeat",
    },
    details: {
      backendDetail: "runtime status observer heartbeat",
    },
  });
});
