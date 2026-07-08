import { logError, logInfo, logWarn } from "./log.js";

type WorkspaceLogLevel = "info" | "warn" | "error";

export interface WorkspaceLogContext {
  userId: string;
  workspace: string;
  ref?: string;
  backend?: string;
  profile?: string;
}

function workspaceLogDetails(
  context: WorkspaceLogContext,
  details?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    userId: context.userId,
    workspace: context.workspace,
    ...(context.ref ? { ref: context.ref } : {}),
    ...(context.backend ? { backend: context.backend } : {}),
    ...(context.profile ? { profile: context.profile } : {}),
    ...(details ?? {}),
  };
}

export function logWorkspaceEvent(
  level: WorkspaceLogLevel,
  event: string,
  context: WorkspaceLogContext,
  details?: Record<string, unknown>,
): void {
  const payload = workspaceLogDetails(context, details);
  if (level === "warn") {
    logWarn("workspace", event, payload);
    return;
  }
  if (level === "error") {
    logError("workspace", event, payload);
    return;
  }
  logInfo("workspace", event, payload);
}

export async function measureWorkspacePhase<T>(args: {
  context: WorkspaceLogContext;
  phase: string;
  slowMs?: number;
  execute: () => Promise<T>;
}): Promise<T> {
  const startedAt = Date.now();
  logWorkspaceEvent("info", "phase-started", args.context, {
    phase: args.phase,
  });
  try {
    const result = await args.execute();
    const elapsedMs = Date.now() - startedAt;
    const level = elapsedMs >= (args.slowMs ?? 2000) ? "warn" : "info";
    logWorkspaceEvent(level, "phase-completed", args.context, {
      phase: args.phase,
      elapsedMs,
      slow: level === "warn",
    });
    return result;
  } catch (error) {
    logWorkspaceEvent("error", "phase-failed", args.context, {
      phase: args.phase,
      elapsedMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
