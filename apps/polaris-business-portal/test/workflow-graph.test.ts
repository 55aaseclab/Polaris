import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildWorkflowGraphLayout } from "../lib/workflow-graph.js";

test("workflow graph falls back to sequential stage edges when dependencies are absent", () => {
  const graph = buildWorkflowGraphLayout([
    {
      depends_on_stage_ids: [],
      id: "fetch",
      label: "Fetch",
      root_path: "workflows/demo/fetch",
      status: { ready: true, status: "final" },
      steps: [{ args: [], command: "fetch", id: "fetch", label: "repo.fetch", tool: "repo" }],
    },
    {
      depends_on_stage_ids: [],
      id: "build",
      label: "Build",
      root_path: "workflows/demo/build",
      status: { ready: false, status: null },
      steps: [{ args: [], command: "build", id: "build", label: "repo.build", tool: "repo" }],
    },
  ]);

  assert.equal(graph.stages.length, 2);
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.edges[0]?.kind, "sequence");
  assert.equal(graph.edges[0]?.inferred, true);
  assert.equal(graph.edges[0]?.source, "fetch");
  assert.equal(graph.edges[0]?.target, "build");
});

test("workflow graph uses explicit dependencies and routes long edges above the stage row", () => {
  const graph = buildWorkflowGraphLayout([
    {
      depends_on_stage_ids: [],
      id: "collect",
      label: "Collect",
      root_path: "workflows/demo/collect",
      status: { ready: true, status: "final" },
      steps: [{ args: [], command: "run", id: "collect", label: "data-collection.run", tool: "data-collection" }],
    },
    {
      depends_on_stage_ids: ["collect"],
      id: "analyze",
      label: "Analyze",
      root_path: "workflows/demo/analyze",
      status: { ready: false, status: "running" },
      steps: [{ args: [], command: "run", id: "analyze", label: "analysis.run", tool: "analysis" }],
    },
    {
      depends_on_stage_ids: ["collect"],
      id: "report",
      label: "Report",
      root_path: "workflows/demo/report",
      status: { ready: false, status: null },
      steps: [{ args: [], command: "run", id: "report", label: "report.run", tool: "report" }],
    },
  ]);

  assert.equal(graph.edges.length, 2);
  assert.deepEqual(
    graph.edges.map((edge) => [edge.source, edge.target, edge.kind, edge.inferred]),
    [
      ["collect", "analyze", "dependency", false],
      ["collect", "report", "dependency", false],
    ],
  );

  const longEdge = graph.edges.find((edge) => edge.target === "report");
  const reportStage = graph.stages.find((stage) => stage.id === "report");
  assert.ok(longEdge);
  assert.ok(reportStage);
  assert.ok((longEdge?.points[2]?.y ?? Infinity) < (reportStage?.y ?? 0));
});

test("workflow graph wraps into snake rows when width is constrained", () => {
  const graph = buildWorkflowGraphLayout([
    {
      depends_on_stage_ids: [],
      id: "stage-1",
      label: "Stage 1",
      root_path: "workflows/demo/stage-1",
      status: { ready: true, status: "final" },
      steps: [{ args: [], command: "run", id: "step-1", label: "tool.run", tool: "tool" }],
    },
    {
      depends_on_stage_ids: [],
      id: "stage-2",
      label: "Stage 2",
      root_path: "workflows/demo/stage-2",
      status: { ready: true, status: "final" },
      steps: [{ args: [], command: "run", id: "step-2", label: "tool.run", tool: "tool" }],
    },
    {
      depends_on_stage_ids: [],
      id: "stage-3",
      label: "Stage 3",
      root_path: "workflows/demo/stage-3",
      status: { ready: false, status: "running" },
      steps: [{ args: [], command: "run", id: "step-3", label: "tool.run", tool: "tool" }],
    },
    {
      depends_on_stage_ids: [],
      id: "stage-4",
      label: "Stage 4",
      root_path: "workflows/demo/stage-4",
      status: { ready: false, status: null },
      steps: [{ args: [], command: "run", id: "step-4", label: "tool.run", tool: "tool" }],
    },
  ], { maxWidth: 860 });

  const stage1 = graph.stages.find((stage) => stage.id === "stage-1");
  const stage2 = graph.stages.find((stage) => stage.id === "stage-2");
  const stage3 = graph.stages.find((stage) => stage.id === "stage-3");
  const stage4 = graph.stages.find((stage) => stage.id === "stage-4");
  const wrapEdge = graph.edges.find((edge) => edge.source === "stage-2" && edge.target === "stage-3");

  assert.ok(stage1);
  assert.ok(stage2);
  assert.ok(stage3);
  assert.ok(stage4);
  assert.equal(stage1?.row, 0);
  assert.equal(stage2?.row, 0);
  assert.equal(stage3?.row, 1);
  assert.equal(stage4?.row, 1);
  assert.ok((stage2?.x ?? 0) > (stage1?.x ?? 0));
  assert.ok((stage3?.x ?? 0) > (stage4?.x ?? 0));
  assert.equal(stage2?.x, stage3?.x);
  assert.ok((stage3?.y ?? 0) > (stage2?.y ?? 0));
  assert.ok(wrapEdge);
  assert.ok((wrapEdge?.points[0]?.y ?? 0) < (wrapEdge?.points.at(-1)?.y ?? 0));
});

test("workflow graph centers rows horizontally inside a wider canvas", () => {
  const graph = buildWorkflowGraphLayout([
    {
      depends_on_stage_ids: [],
      id: "left",
      label: "Left",
      root_path: "workflows/demo/left",
      status: { ready: true, status: "final" },
      steps: [{ args: [], command: "run", id: "left-step", label: "tool.run", tool: "tool" }],
    },
    {
      depends_on_stage_ids: [],
      id: "right",
      label: "Right",
      root_path: "workflows/demo/right",
      status: { ready: false, status: null },
      steps: [{ args: [], command: "run", id: "right-step", label: "tool.run", tool: "tool" }],
    },
  ], { maxWidth: 1200 });

  const left = graph.stages.find((stage) => stage.id === "left");
  const right = graph.stages.find((stage) => stage.id === "right");

  assert.ok(left);
  assert.ok(right);
  assert.equal(graph.width, 1200);
  assert.equal(left?.x, 236);
  assert.equal(right?.x, 644);
});

test("workflow graph uses a uniform card height across stages", () => {
  const graph = buildWorkflowGraphLayout([
    {
      depends_on_stage_ids: [],
      id: "short",
      label: "Short",
      root_path: "workflows/demo/short",
      status: { ready: true, status: "final" },
      steps: [{ args: [], command: "run", id: "short-step", label: "tool.run", tool: "tool" }],
    },
    {
      depends_on_stage_ids: [],
      id: "tall",
      label: "Tall",
      root_path: "workflows/demo/tall",
      status: { ready: false, status: null },
      steps: [
        { args: [], command: "run", id: "step-1", label: "tool.run", tool: "tool" },
        { args: [], command: "run", id: "step-2", label: "tool.run", tool: "tool" },
        { args: [], command: "run", id: "step-3", label: "tool.run", tool: "tool" },
      ],
    },
  ]);

  const heights = [...new Set(graph.stages.map((stage) => stage.height))];
  assert.deepEqual(heights, [278]);
});

test("workflow graph panel keeps scrollbar gutter stable on scroll containers", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../components/workflow-graph-panel.tsx", import.meta.url)),
    "utf8",
  );

  assert.match(
    source,
    /overflow-y-auto overflow-x-hidden bg-muted\/20 \[scrollbar-gutter:stable\]/,
  );
  assert.match(
    source,
    /space-y-2 overflow-y-auto px-3 py-3 \[scrollbar-gutter:stable\]/,
  );
  assert.match(
    source,
    /row\.value \?\? "—"/,
  );
  assert.match(source, /useId/);
  assert.match(source, /id=\{markerId\}/);
  assert.match(source, /markerEnd=\{`url\(#\$\{markerId\}\)`\}/);
});
