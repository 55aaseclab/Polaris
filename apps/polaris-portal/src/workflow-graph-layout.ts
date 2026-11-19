import type { WorkflowGraphProjection } from "@polaris/polaris-shell";
import { graphlib } from "dagre-d3-es";
import { layout as dagreLayout } from "dagre-d3-es/src/dagre/index.js";

type GraphEdge = WorkflowGraphProjection["flow"]["edges"][number];

export type WorkflowGraphNodeLayout = {
  id: string;
  x: number;
  y: number;
};

export type WorkflowGraphEdgeLayout = {
  edge: GraphEdge;
  d: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
};

export type WorkflowGraphLayout = {
  width: number;
  height: number;
  nodeWidth: number;
  nodeHeight: number;
  positions: Map<string, WorkflowGraphNodeLayout>;
  edges: WorkflowGraphEdgeLayout[];
};

const NODE_WIDTH = 232;
const NODE_HEIGHT = 102;
const PADDING_X = 36;
const PADDING_Y = 28;

type DagreNode = {
  width: number;
  height: number;
  x?: number;
  y?: number;
};

function edgeKey(edge: GraphEdge, index: number): string {
  return `${edge.from}->${edge.to}:${edge.field ?? index}`;
}

type DagreEdge = {
  points?: { x: number; y: number }[];
};

function pathFromPoints(points: { x: number; y: number }[]): string {
  return points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${PADDING_X + point.x} ${PADDING_Y + point.y}`)
    .join(" ");
}

export function layoutWorkflowGraph(graph: WorkflowGraphProjection): WorkflowGraphLayout {
  const dag = new graphlib.Graph({ directed: true, multigraph: true })
    .setGraph({ rankdir: "LR", align: "UL", nodesep: 42, ranksep: 110, edgesep: 18 })
    .setDefaultEdgeLabel(() => ({ weight: 1 }));

  for (const node of graph.flow.nodes) {
    dag.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  }
  graph.flow.edges.forEach((edge, index) => {
    dag.setEdge(edge.from, edge.to, { weight: 1 }, edgeKey(edge, index));
  });
  dagreLayout(dag, {});

  const positions = new Map<string, WorkflowGraphNodeLayout>();
  for (const id of dag.nodes()) {
    const node = dag.node(id) as DagreNode | undefined;
    if (!node || node.x === undefined || node.y === undefined) continue;
    positions.set(String(id), {
      id: String(id),
      x: PADDING_X + node.x - NODE_WIDTH / 2,
      y: PADDING_Y + node.y - NODE_HEIGHT / 2,
    });
  }
  const bounds = [...positions.values()].reduce(
    (box, node) => ({
      maxX: Math.max(box.maxX, node.x + NODE_WIDTH),
      maxY: Math.max(box.maxY, node.y + NODE_HEIGHT),
    }),
    { maxX: 0, maxY: 0 },
  );
  const width = Math.max(980, bounds.maxX + PADDING_X);
  const height = Math.max(320, bounds.maxY + PADDING_Y);

  const edgeLayouts = graph.flow.edges.map((edge, index) => {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (!from || !to) return null;
    const laidOut = dag.edge({ v: edge.from, w: edge.to, name: edgeKey(edge, index) }) as DagreEdge | undefined;
    const points = laidOut?.points ?? [];
    const first = points[0];
    const last = points.at(-1);
    const fromX = first ? PADDING_X + first.x : from.x + NODE_WIDTH;
    const fromY = first ? PADDING_Y + first.y : from.y + NODE_HEIGHT / 2;
    const toX = last ? PADDING_X + last.x : to.x;
    const toY = last ? PADDING_Y + last.y : to.y + NODE_HEIGHT / 2;
    const d = points.length > 0
      ? pathFromPoints(points)
      : `M ${fromX} ${fromY} L ${toX} ${toY}`;
    return { edge, d, fromX, fromY, toX, toY, key: edgeKey(edge, index) };
  }).filter((edge): edge is WorkflowGraphEdgeLayout & { key: string } => Boolean(edge));

  return {
    width,
    height,
    nodeWidth: NODE_WIDTH,
    nodeHeight: NODE_HEIGHT,
    positions,
    edges: edgeLayouts,
  };
}
