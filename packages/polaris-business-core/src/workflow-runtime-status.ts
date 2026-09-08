import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type WorkflowRuntimeProcess = {
  cmd: string;
  pid: number;
};

export type WorkflowRuntimeStage = {
  key: string;
  rootPath: string;
  stageId: string;
  workflowId: string;
};

function isToolLikeCommand(cmd: string): boolean {
  return (
    /(?:^|\/)(?:clue-[\w-]+|runner\.py|codex)(?:\s|$)/.test(cmd)
    || /tools\/(?:data-collection|intelligence-analysis|report-writing|codex)\//.test(
      cmd,
    )
  );
}

function stageToolPatterns(stageId: string): RegExp[] {
  switch (stageId) {
    case "data-collection":
      return [/tools\/data-collection\//, /clue-data-collection(?:\s|$)/];
    case "intelligence-analysis":
      return [
        /tools\/intelligence-analysis\//,
        /clue-intelligence-analysis(?:\s|$)/,
      ];
    case "report-writing":
      return [/tools\/report-writing\//, /clue-report-writing(?:\s|$)/];
    default:
      return [/runner\.py/, /clue-[\w-]+/];
  }
}

/** A stable local key for a workflow stage within a process snapshot. */
export function workflowRuntimeStageKey(workflowId: string, stageId: string): string {
  return `${workflowId}\0${stageId}`;
}

/** Read process command lines once so callers can classify multiple stages together. */
export function readWorkflowRuntimeProcesses(procRoot = "/proc"): WorkflowRuntimeProcess[] {
  let entries: string[];
  try {
    entries = readdirSync(procRoot);
  } catch {
    return [];
  }

  const processes: WorkflowRuntimeProcess[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const raw = readFileSync(join(procRoot, entry, "cmdline"));
      if (!raw.length) continue;
      const cmd = raw.toString("utf8").replace(/\0/g, " ").trim();
      if (cmd) processes.push({ cmd, pid: Number(entry) });
    } catch {
      // The process may have exited while its command line was being read.
    }
  }
  return processes;
}

/**
 * Match the Wanghai tool processes that belong to the supplied workflow stages.
 * This is best-effort status only; it neither starts nor controls a workflow.
 */
export function findRunningWorkflowStages(
  stages: readonly WorkflowRuntimeStage[],
  processes: readonly WorkflowRuntimeProcess[] = readWorkflowRuntimeProcesses(),
): Map<string, WorkflowRuntimeProcess[]> {
  const candidates = stages.flatMap((stage) => {
    const markers = [stage.rootPath, stage.workflowId]
      .filter((marker) => marker.length >= 12);
    if (!stage.key || !markers.length) return [];
    return [{ ...stage, markers, patterns: stageToolPatterns(stage.stageId) }];
  });
  const matches = new Map<string, WorkflowRuntimeProcess[]>();

  for (const process of processes) {
    if (!isToolLikeCommand(process.cmd)) continue;
    for (const stage of candidates) {
      if (!stage.patterns.some((pattern) => pattern.test(process.cmd))) continue;
      if (!stage.markers.some((marker) => process.cmd.includes(marker))) continue;
      const running = matches.get(stage.key) ?? [];
      running.push({ ...process, cmd: process.cmd.slice(0, 240) });
      matches.set(stage.key, running);
    }
  }
  return matches;
}
