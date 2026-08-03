import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createExecutorServer } from "../scripts/executor/server.js";

test("executor server starts on loopback without a shared secret", async () => {
  const server = createExecutorServer(0, "127.0.0.1");
  await once(server, "listening");
  server.close();
  await once(server, "close");
});

test("executor server rejects non-loopback bind hosts", async () => {
  assert.throws(
    () => createExecutorServer(0, "0.0.0.0"),
    /must bind to 127\.0\.0\.1/i,
  );
});

test("executor server starts on loopback", async () => {
  const server = createExecutorServer(0, "127.0.0.1");
  await once(server, "listening");
  server.close();
  await once(server, "close");
});
