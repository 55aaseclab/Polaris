import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeEmbeddedPaseoFrames,
  type EmbeddedPaseoFrame,
} from "../../polaris-web/src/lib/paseo-frames";

test("sidebar frame prewarm keeps an iframe created from workspace detail data", () => {
  const current: EmbeddedPaseoFrame[] = [
    {
      workspaceKey: "cyruscyliu:test3",
      src: "http://127.0.0.1:8082/h/srv_detail",
      loaded: false,
    },
  ];

  const merged = mergeEmbeddedPaseoFrames(current, ["cyruscyliu:test3"], []);
  assert.equal(merged, current);
  assert.deepEqual(merged, current);
});

test("sidebar frame prewarm updates known frames without dropping detail-only frames", () => {
  const current: EmbeddedPaseoFrame[] = [
    {
      workspaceKey: "cyruscyliu:test3",
      src: "http://127.0.0.1:8082/h/srv_detail",
      loaded: true,
    },
    {
      workspaceKey: "cyruscyliu:test4",
      src: "http://127.0.0.1:8082/h/srv_old",
      loaded: true,
    },
  ];

  const merged = mergeEmbeddedPaseoFrames(current, [
    "cyruscyliu:test3",
    "cyruscyliu:test4",
  ], [
    {
      workspaceKey: "cyruscyliu:test4",
      src: "http://127.0.0.1:8082/h/srv_new",
    },
  ]);

  assert.deepEqual(merged, [
    {
      workspaceKey: "cyruscyliu:test3",
      src: "http://127.0.0.1:8082/h/srv_detail",
      loaded: true,
    },
    {
      workspaceKey: "cyruscyliu:test4",
      src: "http://127.0.0.1:8082/h/srv_new",
      loaded: false,
    },
  ]);
});

test("sidebar frame sync removes frames for workspaces that no longer exist", () => {
  const current: EmbeddedPaseoFrame[] = [
    {
      workspaceKey: "cyruscyliu:test3",
      src: "http://127.0.0.1:8082/h/srv_detail",
      loaded: true,
    },
    {
      workspaceKey: "cyruscyliu:archived",
      src: "http://127.0.0.1:8082/h/srv_archived",
      loaded: true,
    },
  ];

  const merged = mergeEmbeddedPaseoFrames(current, ["cyruscyliu:test3"], []);
  assert.deepEqual(merged, [
    {
      workspaceKey: "cyruscyliu:test3",
      src: "http://127.0.0.1:8082/h/srv_detail",
      loaded: true,
    },
  ]);
});
