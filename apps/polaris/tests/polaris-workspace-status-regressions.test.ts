import test from "node:test";
import assert from "node:assert/strict";
test("normalizeWorkspaceStatus accepts schema-less 1.1-shaped statuses", async () => {
  const { normalizeWorkspaceStatus } = await import(
    `../scripts/output/state-store.ts?case=${Date.now()}-${Math.random().toString(16).slice(2)}`
  );
  const normalized = normalizeWorkspaceStatus({
    project: "demo",
    driver: {
      selected: { backend: "docker" },
      status: "running",
      reason: "heartbeat",
    },
    paseo: {
      daemon: "ready",
      web: "connectable",
      reconnectMode: "reconnectable",
      liveTarget: null,
      reconnectTarget: null,
    },
    details: {},
  });
  assert.equal(normalized.schemaVersion, 1.1);
  assert.equal(normalized.driver?.status, "running");
  assert.deepEqual(normalized.driver?.selected, { backend: "docker" });
});
