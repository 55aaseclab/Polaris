import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowGraphProjection } from "@polaris/polaris-shell";
import { layoutWorkflowGraph } from "./workflow-graph-layout.js";

const graph: WorkflowGraphProjection = {
  packId: "SamplePack",
  packVersion: "1.0.0",
  packDigest: "sha256:sample",
  flowId: "Review",
  flowTitle: "Review",
  flow: {
    nodes: [
      { id: "__input__", label: "Input", kind: "input", uses: [], outputs: ["a", "b", "c", "d"] },
      { id: "prepare", label: "Prepare", kind: "step", uses: ["a", "b", "c", "d"], outputs: ["prepared"] },
      { id: "__output__", label: "Output", kind: "output", uses: ["prepared"], outputs: ["prepared"] },
    ],
    edges: [
      { from: "__input__", to: "prepare", field: "a" },
      { from: "__input__", to: "prepare", field: "b" },
      { from: "__input__", to: "prepare", field: "c" },
      { from: "__input__", to: "prepare", field: "d" },
      { from: "prepare", to: "__output__", field: "prepared" },
    ],
  },
};

test("workflow graph layout gives parallel field edges separate ports", () => {
  const layout = layoutWorkflowGraph(graph);
  const edges = layout.edges.filter((edge) => edge.edge.to === "prepare");

  assert.equal(edges.length, 4);
  assert.equal(new Set(edges.map((edge) => edge.d)).size, 4);
  assert.equal(new Set(edges.map((edge) => edge.fromY)).size, 4);
  assert.equal(new Set(edges.map((edge) => edge.toY)).size, 4);
  assert.ok(edges.every((edge) => edge.d.includes(`L ${edge.toX} ${edge.toY}`)));
});
