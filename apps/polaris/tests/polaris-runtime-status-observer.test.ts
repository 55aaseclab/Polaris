import test from "node:test";
import assert from "node:assert/strict";
import { isTransientExecutorDisconnect } from "../scripts/runtime/status-observer.mjs";

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
