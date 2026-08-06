import assert from "node:assert/strict";
import test from "node:test";
import { runControlPlanePerformanceBenchmark } from "../scripts/benchmark/control-plane-performance-runner.js";

test("control-plane performance benchmark measures worker and mutation admission paths", async () => {
  const result = await runControlPlanePerformanceBenchmark({
    samples: 3,
    warmupSamples: 1,
  });

  assert.equal(result.kind, "polaris-control-plane-performance-benchmark");
  for (const operation of Object.values(result.operations)) {
    assert.equal(operation.count, 3);
    assert.ok(operation.p50Ms >= 0);
    assert.ok(operation.p95Ms >= operation.p50Ms);
    assert.ok(operation.p99Ms >= operation.p95Ms);
  }
  assert.deepEqual(result.errors, {
    "control-store.mutation-admission": 0,
    "worker.provision": 0,
  });
  assert.ok(result.process.userCpuMs >= 0);
  assert.ok(result.process.systemCpuMs >= 0);
  assert.ok(result.process.peakRssBytes > 0);
  assert.ok(result.process.eventLoopDelay.p95Ms >= result.process.eventLoopDelay.p50Ms);
  assert.ok(result.process.eventLoopDelay.p99Ms >= result.process.eventLoopDelay.p95Ms);
});
