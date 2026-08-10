import assert from "node:assert/strict";
import test from "node:test";
import { durableJobWorkerConcurrency } from "../scripts/control-plane/jobs/concurrency.js";
import {
  startDurableJobRecoveryLoop,
  stopDurableJobRecoveryLoop,
} from "../scripts/control-plane/operations.js";

test("durable workers use the release-profile concurrency setting", () => {
  assert.equal(durableJobWorkerConcurrency({}), 1);
  assert.equal(durableJobWorkerConcurrency({ POLARIS_JOB_WORKER_CONCURRENCY: "1" }), 1);
  assert.equal(
    durableJobWorkerConcurrency({
      POLARIS_JOB_CONCURRENCY: "4",
      POLARIS_JOB_WORKER_CONCURRENCY: "1",
    }),
    1,
  );
  assert.equal(durableJobWorkerConcurrency({ POLARIS_JOB_WORKER_CONCURRENCY: "3" }), 3);
});

test("durable recovery loop resumes expired work without a client replay", () => {
  let scheduled: (() => void) | null = null;
  let scheduledDelay = 0;
  let resumeCalls = 0;
  let unrefCalls = 0;
  const fakeTimer = {
    unref() {
      unrefCalls += 1;
      return fakeTimer;
    },
  } as unknown as NodeJS.Timeout;

  try {
    assert.equal(startDurableJobRecoveryLoop({
      intervalMs: 250,
      resume: async () => {
        resumeCalls += 1;
      },
      schedule: (callback, intervalMs) => {
        scheduled = callback;
        scheduledDelay = intervalMs;
        return fakeTimer;
      },
    }), true);
    assert.equal(scheduledDelay, 250);
    assert.equal(unrefCalls, 1);
    assert.equal(startDurableJobRecoveryLoop(), false);
    scheduled?.();
    assert.equal(resumeCalls, 1);
  } finally {
    stopDurableJobRecoveryLoop();
  }
});
