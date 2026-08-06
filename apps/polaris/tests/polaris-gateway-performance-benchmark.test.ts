import assert from "node:assert/strict";
import test from "node:test";
import { runGatewayPerformanceBenchmark } from "../scripts/benchmark/gateway-performance-runner.js";

test("gateway performance benchmark measures the fixed local user path", async () => {
  const result = await runGatewayPerformanceBenchmark({
    samples: 3,
    vaults: 2,
    warmupSamples: 1,
  });

  assert.equal(result.kind, "polaris-gateway-performance-benchmark");
  assert.equal(result.fixture.vaults, 2);
  for (const operation of Object.values(result.operations)) {
    assert.equal(operation.count, 3);
    assert.ok(operation.p50Ms >= 0);
    assert.ok(operation.p95Ms >= operation.p50Ms);
    assert.ok(operation.p99Ms >= operation.p95Ms);
  }
  assert.deepEqual(result.errors, {
    "portal.hosts.list": 0,
    "gateway.launch": 0,
    "gateway.exchange": 0,
    "gateway.read": 0,
  });
  assert.ok(result.process.userCpuMs >= 0);
  assert.ok(result.process.systemCpuMs >= 0);
  assert.ok(result.process.peakRssBytes > 0);
  assert.ok(result.process.eventLoopDelay.p95Ms >= result.process.eventLoopDelay.p50Ms);
  assert.ok(result.process.eventLoopDelay.p99Ms >= result.process.eventLoopDelay.p95Ms);
});
