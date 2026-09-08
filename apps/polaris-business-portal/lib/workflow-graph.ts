export type WorkflowGraphStep = {
  args: string[];
  command: string;
  id: string;
  label: string;
  tool: string;
};

export type WorkflowGraphStage = {
  depends_on_stage_ids: string[];
  id: string;
  label: string;
  root_path: string;
  status: {
    ready: boolean;
    status: string | null;
  };
  steps: WorkflowGraphStep[];
};

export type WorkflowGraphEdge = {
  id: string;
  inferred: boolean;
  kind: "dependency" | "sequence";
  points: Array<{ x: number; y: number }>;
  source: string;
  target: string;
};

export type PositionedWorkflowGraphStage = WorkflowGraphStage & {
  height: number;
  index: number;
  row: number;
  width: number;
  x: number;
  y: number;
};

export type WorkflowGraphLayout = {
  edges: WorkflowGraphEdge[];
  height: number;
  stages: PositionedWorkflowGraphStage[];
  width: number;
};

export type WorkflowGraphLayoutOptions = {
  maxWidth?: number | null;
};

const STAGE_WIDTH = 320;
const STAGE_GAP = 88;
const STAGE_HORIZONTAL_PADDING = 24;
const EDGE_LANE_GAP = 28;
const EDGE_LANE_TOP_PADDING = 18;
const STAGE_TOP_PADDING = 36;
const STAGE_BOTTOM_PADDING = 28;
const ROW_GAP = 120;
const HEADER_HEIGHT = 74;
const STEP_HEIGHT = 62;
const EMPTY_STEP_HEIGHT = 54;
const MIN_STAGE_HEIGHT = 240;
const MAX_STAGE_HEIGHT = 360;

type RawWorkflowGraphEdge = {
  inferred: boolean;
  kind: "dependency" | "sequence";
  source: string;
  target: string;
};

function stageHeight(stage: WorkflowGraphStage): number {
  const dependencyBannerHeight = stage.depends_on_stage_ids.length > 0 ? 26 : 0;
  const stepCount = Math.max(stage.steps.length, 1);
  const bodyHeight = stage.steps.length > 0
    ? stepCount * STEP_HEIGHT
    : EMPTY_STEP_HEIGHT;
  return HEADER_HEIGHT + dependencyBannerHeight + bodyHeight + 18;
}

function uniformStageHeight(stages: WorkflowGraphStage[]): number {
  const desired = Math.max(...stages.map((stage) => stageHeight(stage)));
  return Math.max(MIN_STAGE_HEIGHT, Math.min(MAX_STAGE_HEIGHT, desired));
}

function stageAnchorY(stage: PositionedWorkflowGraphStage): number {
  return stage.y + 36;
}

function stageCenterX(stage: PositionedWorkflowGraphStage): number {
  return stage.x + stage.width / 2;
}

function stageTopAnchor(stage: PositionedWorkflowGraphStage): { x: number; y: number } {
  return { x: stageCenterX(stage), y: stage.y };
}

function stageBottomAnchor(stage: PositionedWorkflowGraphStage): { x: number; y: number } {
  return { x: stageCenterX(stage), y: stage.y + stage.height };
}

function stageSideAnchor(
  stage: PositionedWorkflowGraphStage,
  side: "left" | "right",
): { x: number; y: number } {
  return {
    x: side === "left" ? stage.x : stage.x + stage.width,
    y: stageAnchorY(stage),
  };
}

function stageIndexById(stages: WorkflowGraphStage[]): Map<string, number> {
  return new Map(stages.map((stage, index) => [stage.id, index]));
}

function buildGraphEdges(stages: WorkflowGraphStage[]): RawWorkflowGraphEdge[] {
  const edges: RawWorkflowGraphEdge[] = [];
  const ids = new Set(stages.map((stage) => stage.id));

  for (const stage of stages) {
    for (const dependency of stage.depends_on_stage_ids) {
      if (!ids.has(dependency) || dependency === stage.id) {
        continue;
      }
      edges.push({
        source: dependency,
        target: stage.id,
        kind: "dependency",
        inferred: false,
      });
    }
  }

  if (edges.length > 0) {
    return edges;
  }

  for (let index = 1; index < stages.length; index += 1) {
    const source = stages[index - 1];
    const target = stages[index];
    if (!source || !target) {
      continue;
    }
    edges.push({
      source: source.id,
      target: target.id,
      kind: "sequence",
      inferred: true,
    });
  }

  return edges;
}

function rowSpanWidth(stageCount: number): number {
  return stageCount * STAGE_WIDTH + Math.max(0, stageCount - 1) * STAGE_GAP;
}

function columnsForWidth(stageCount: number, maxWidth?: number | null): number {
  if (!maxWidth || !Number.isFinite(maxWidth)) {
    return Math.max(1, stageCount);
  }
  const usableWidth = Math.max(maxWidth, STAGE_HORIZONTAL_PADDING * 2 + STAGE_WIDTH);
  const columns = Math.floor((usableWidth - STAGE_HORIZONTAL_PADDING * 2 + STAGE_GAP) / (STAGE_WIDTH + STAGE_GAP));
  return Math.max(1, Math.min(stageCount, columns));
}

export function buildWorkflowGraphLayout(
  stages: WorkflowGraphStage[],
  options: WorkflowGraphLayoutOptions = {},
): WorkflowGraphLayout {
  if (stages.length === 0) {
    return {
      width: STAGE_HORIZONTAL_PADDING * 2 + STAGE_WIDTH,
      height: STAGE_TOP_PADDING + STAGE_BOTTOM_PADDING + HEADER_HEIGHT + EMPTY_STEP_HEIGHT,
      stages: [],
      edges: [],
    };
  }

  const rawEdges = buildGraphEdges(stages);
  const indexes = stageIndexById(stages);
  const stageHeightValue = uniformStageHeight(stages);
  const columns = columnsForWidth(stages.length, options.maxWidth);
  const rows = Array.from({ length: Math.ceil(stages.length / columns) }, (_, row) =>
    stages.slice(row * columns, row * columns + columns),
  );

  const rowHeights = rows.map(() => stageHeightValue);
  const rowSpanWidths = rows.map((rowStages) => rowSpanWidth(rowStages.length));

  const rowIndexByStageId = new Map<string, number>();
  rows.forEach((rowStages, rowIndex) => {
    rowStages.forEach((stage) => {
      rowIndexByStageId.set(stage.id, rowIndex);
    });
  });

  const archDependencyEdges = rawEdges
    .filter((edge) => (
      edge.kind === "dependency"
      && rowIndexByStageId.get(edge.source) !== rowIndexByStageId.get(edge.target)
    ))
    .sort((left, right) => {
      const leftSpan = Math.abs((rowIndexByStageId.get(left.target) ?? 0) - (rowIndexByStageId.get(left.source) ?? 0));
      const rightSpan = Math.abs((rowIndexByStageId.get(right.target) ?? 0) - (rowIndexByStageId.get(right.source) ?? 0));
      return rightSpan - leftSpan;
    });
  const archLaneIndex = new Map<string, number>(archDependencyEdges.map((edge, index) => [`${edge.source}->${edge.target}`, index]));
  const topInset = STAGE_TOP_PADDING + (
    archDependencyEdges.length > 0
      ? EDGE_LANE_TOP_PADDING + archDependencyEdges.length * EDGE_LANE_GAP
      : 0
  );

  const positionedStages: PositionedWorkflowGraphStage[] = [];
  const minCanvasWidth = STAGE_HORIZONTAL_PADDING * 2 + STAGE_WIDTH;
  const contentWidth = Math.max(...rowSpanWidths) + STAGE_HORIZONTAL_PADDING * 2;
  const width = Math.max(minCanvasWidth, contentWidth, options.maxWidth ?? 0);
  let currentY = topInset;
  rows.forEach((rowStages, rowIndex) => {
    const reversed = rowIndex % 2 === 1;
    const startX = Math.max(
      STAGE_HORIZONTAL_PADDING,
      Math.floor((width - rowSpanWidths[rowIndex]!) / 2),
    );
    rowStages.forEach((stage, stageOffset) => {
      const visualColumn = reversed
        ? rowStages.length - 1 - stageOffset
        : stageOffset;
      positionedStages.push({
        ...stage,
        index: rowIndex * columns + stageOffset,
        row: rowIndex,
        width: STAGE_WIDTH,
        height: stageHeightValue,
        x: startX + visualColumn * (STAGE_WIDTH + STAGE_GAP),
        y: currentY,
      });
    });
    currentY += rowHeights[rowIndex]! + ROW_GAP;
  });

  const byId = new Map(positionedStages.map((stage) => [stage.id, stage]));
  const height = currentY - ROW_GAP + STAGE_BOTTOM_PADDING;

  const edges: WorkflowGraphEdge[] = rawEdges.flatMap((edge) => {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target) {
      return [];
    }

    const sameRow = source.row === target.row;
    const span = Math.abs(target.index - source.index);
    const key = `${edge.source}->${edge.target}`;
    const points = edge.kind === "sequence" && !sameRow
      ? (() => {
          const sourceAnchor = stageBottomAnchor(source);
          const targetAnchor = stageTopAnchor(target);
          const laneY = source.y + rowHeights[source.row]! + ROW_GAP / 2;
          return [
            sourceAnchor,
            { x: sourceAnchor.x, y: laneY },
            { x: targetAnchor.x, y: laneY },
            targetAnchor,
          ];
        })()
      : edge.kind === "dependency" && (!sameRow || span > 1)
        ? (() => {
            const sourceAnchor = stageTopAnchor(source);
            const targetAnchor = stageTopAnchor(target);
            const lane = archLaneIndex.get(key) ?? 0;
            const laneY = EDGE_LANE_TOP_PADDING + lane * EDGE_LANE_GAP + 8;
            return [
              sourceAnchor,
              { x: sourceAnchor.x, y: laneY },
              { x: targetAnchor.x, y: laneY },
              targetAnchor,
            ];
          })()
        : (() => {
            const leftToRight = target.x >= source.x;
            const sourceAnchor = stageSideAnchor(source, leftToRight ? "right" : "left");
            const targetAnchor = stageSideAnchor(target, leftToRight ? "left" : "right");
            const sourceOffset = leftToRight ? 24 : -24;
            const targetOffset = leftToRight ? -24 : 24;
            return span <= 1
              ? [
                  sourceAnchor,
                  { x: sourceAnchor.x + sourceOffset, y: sourceAnchor.y },
                  { x: targetAnchor.x + targetOffset, y: targetAnchor.y },
                  targetAnchor,
                ]
              : [
                  sourceAnchor,
                  { x: sourceAnchor.x + sourceOffset, y: sourceAnchor.y },
                  { x: sourceAnchor.x + sourceOffset, y: targetAnchor.y },
                  { x: targetAnchor.x + targetOffset, y: targetAnchor.y },
                  targetAnchor,
                ];
          })();

    return [{
      id: `${edge.kind}:${edge.source}:${edge.target}`,
      source: edge.source,
      target: edge.target,
      kind: edge.kind,
      inferred: edge.inferred,
      points,
    }];
  });

  return {
    width,
    height,
    stages: positionedStages,
    edges,
  };
}
