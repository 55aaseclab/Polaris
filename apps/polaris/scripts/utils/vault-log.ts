import { logError, logInfo, logWarn } from "./log.js";

type VaultLogLevel = "info" | "warn" | "error";

export interface VaultLogContext {
  userId: string;
  vault: string;
  ref?: string;
  backend?: string;
  profile?: string;
}

function vaultLogDetails(
  context: VaultLogContext,
  details?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    userId: context.userId,
    vault: context.vault,
    ...(context.ref ? { ref: context.ref } : {}),
    ...(context.backend ? { backend: context.backend } : {}),
    ...(context.profile ? { profile: context.profile } : {}),
    ...(details ?? {}),
  };
}

export function logVaultEvent(
  level: VaultLogLevel,
  event: string,
  context: VaultLogContext,
  details?: Record<string, unknown>,
): void {
  const payload = vaultLogDetails(context, details);
  if (level === "warn") {
    logWarn("vault", event, payload);
    return;
  }
  if (level === "error") {
    logError("vault", event, payload);
    return;
  }
  logInfo("vault", event, payload);
}

export async function measureVaultPhase<T>(args: {
  context: VaultLogContext;
  phase: string;
  slowMs?: number;
  execute: () => Promise<T>;
}): Promise<T> {
  const startedAt = Date.now();
  logVaultEvent("info", "phase-started", args.context, {
    phase: args.phase,
  });
  try {
    const result = await args.execute();
    const elapsedMs = Date.now() - startedAt;
    const level = elapsedMs >= (args.slowMs ?? 2000) ? "warn" : "info";
    logVaultEvent(level, "phase-completed", args.context, {
      phase: args.phase,
      elapsedMs,
      slow: level === "warn",
    });
    return result;
  } catch (error) {
    logVaultEvent("error", "phase-failed", args.context, {
      phase: args.phase,
      elapsedMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
