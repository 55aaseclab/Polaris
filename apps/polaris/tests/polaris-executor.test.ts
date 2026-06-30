import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createExecutorServer } from "../scripts/executor/server.js";

async function withEnv(
  name: string,
  value: string | undefined,
  fn: () => Promise<void>,
): Promise<void> {
  const previous = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  try {
    await fn();
  } finally {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  }
}

test("executor server requires POLARIS_EXECUTOR_SHARED_SECRET", async () => {
  await withEnv("POLARIS_EXECUTOR_SHARED_SECRET", undefined, async () => {
    assert.throws(
      () => createExecutorServer(0, "127.0.0.1"),
      /POLARIS_EXECUTOR_SHARED_SECRET is required/i,
    );
  });
});

test("executor server rejects non-loopback bind hosts", async () => {
  await withEnv("POLARIS_EXECUTOR_SHARED_SECRET", "test-secret", async () => {
    assert.throws(
      () => createExecutorServer(0, "0.0.0.0"),
      /must bind to 127\.0\.0\.1/i,
    );
  });
});

test("executor server starts on loopback when secret is configured", async () => {
  await withEnv("POLARIS_EXECUTOR_SHARED_SECRET", "test-secret", async () => {
    const server = createExecutorServer(0, "127.0.0.1");
    await once(server, "listening");
    server.close();
    await once(server, "close");
  });
});
