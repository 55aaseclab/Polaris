import assert from "node:assert/strict";
import test from "node:test";
import { durableJobWorkerConcurrency } from "../scripts/runtime/job-concurrency.js";

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
