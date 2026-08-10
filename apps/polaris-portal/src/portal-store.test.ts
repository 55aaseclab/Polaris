import assert from "node:assert/strict";
import test from "node:test";
import { applyVaultStreamEvent, type PortalVaultState } from "./portal-store.js";

const base: PortalVaultState = {
  hostsByName: {
    demo: {
      name: "demo",
      serverId: "srv_demo",
      wanghaiId: null,
      surfaces: ["paseo"],
      status: { driver: { status: "starting" } },
    },
  },
  staticByName: {},
  liveByName: {},
};

test("live-upsert replaces the visible host status without losing route identity", () => {
  const next = applyVaultStreamEvent(base, {
    type: "live-upsert",
    vault: { name: "demo", status: { driver: { status: "running" } } },
  });
  assert.equal(next.hostsByName.demo.serverId, "srv_demo");
  assert.equal(next.hostsByName.demo.status?.driver?.status, "running");
});

test("snapshot removes hosts no longer present and preserves live status", () => {
  const next = applyVaultStreamEvent(base, {
    type: "snapshot",
    staticVaults: [{ name: "demo", availableDrivers: [] }],
    liveVaults: [{ name: "demo", status: { driver: { status: "stopped" } } }],
  });
  assert.deepEqual(Object.keys(next.hostsByName), ["demo"]);
  assert.equal(next.hostsByName.demo.status?.driver?.status, "stopped");
});

test("static-remove clears the host and its live projection", () => {
  const populated = applyVaultStreamEvent(base, {
    type: "live-upsert",
    vault: { name: "demo", status: { driver: { status: "running" } } },
  });
  const next = applyVaultStreamEvent(populated, { type: "static-remove", vault: "demo" });
  assert.equal(next.hostsByName.demo, undefined);
  assert.equal(next.liveByName.demo, undefined);
});
