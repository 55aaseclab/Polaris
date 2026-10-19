import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ClhError } from "./errors.js";
import { computeCostUsd, type ClhEnv } from "./env.js";
import { compileDshRun, type CompiledDshRun } from "./dsh-compiler.js";
import {
  findNewestSessionLog,
  readSessionLog,
  summarizeSessionLog,
  type SessionTokenUsage,
} from "./session-log.js";
import type { HarnessPreset } from "./schema.js";

export interface DshRunOptions {
  preset: HarnessPreset;
  presetDir: string;
  taskContext: Record<string, string>;
  env: ClhEnv;
  /** Sandbox workspace root and dsh child cwd. */
  workspaceRoot: string;
  /** Overrides preset.timeoutMs and POLARIS_CLH_TIMEOUT_MS (PRD 3.14.2). */
  timeoutMs?: number;
  /** Keep the temp patch file instead of deleting it after the run. */
  keepPatch?: boolean;
  /** Skip the actual dsh spawn; only compile and write the patch. */
  dryRun?: boolean;
}

export interface DshReceipt {
  costUsd?: number;
  tokens: SessionTokenUsage;
  toolCalls: number;
  exitCode: number | null;
  sessionLogPath?: string;
  durationMs: number;
  turnCount: number;
  finalText?: string;
  endedReason?: string;
  modelId: string;
  outputContract: HarnessPreset["outputContract"];
}

/**
 * Run one preset through the dsh headless backend: compile the patch overlay
 * (temp file, one-shot), spawn dsh, locate the durable session log, and parse
 * it into a receipt. Cost reads back from tier pricing; unset pricing yields
 * an honest undefined. Cached reads are a separate usage bucket in the dsh
 * session log (PRD 3.14.8), so billing uses the cached-separate semantics and
 * the receipt tokens carry the cache-read split with its disclosure source.
 */
export async function runDshPreset(options: DshRunOptions): Promise<DshReceipt> {
  const startedAt = Date.now();
  const compiled = await compileDshRun(options);

  const runDir = await mkdtemp(path.join(tmpdir(), "clh-run-"));
  const patchPath = path.join(runDir, "clh-patch.yaml");
  await writeFile(patchPath, compiled.patchYaml, "utf8");

  try {
    if (options.dryRun) {
      return {
        tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0 },
        toolCalls: 0,
        exitCode: 0,
        durationMs: Date.now() - startedAt,
        turnCount: 0,
        modelId: compiled.modelId,
        outputContract: options.preset.outputContract,
      };
    }
    const { exitCode, sessionLogPath, sessionEvents } = await spawnDsh(options, compiled, patchPath);
    const receipt: DshReceipt = {
      tokens: { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedTokens: 0 },
      toolCalls: 0,
      exitCode,
      durationMs: Date.now() - startedAt,
      turnCount: 0,
      modelId: compiled.modelId,
      outputContract: options.preset.outputContract,
    };
    if (sessionLogPath && sessionEvents) {
      const summary = summarizeSessionLog(sessionLogPath, sessionEvents);
      receipt.sessionLogPath = sessionLogPath;
      receipt.tokens = summary.tokens;
      receipt.toolCalls = summary.toolCalls.length;
      receipt.turnCount = summary.turnCount;
      receipt.finalText = summary.finalText;
      receipt.endedReason = summary.endedReason;
      receipt.costUsd = computeCostUsd(summary.tokens, options.preset.model, options.env, "cached-separate");
      enforceOutputContract(options.preset.outputContract, receipt.finalText, receipt.toolCalls);
    }
    return receipt;
  } finally {
    if (!options.keepPatch) {
      await rm(runDir, { recursive: true, force: true });
    }
  }
}

interface SpawnedDsh {
  exitCode: number | null;
  sessionLogPath?: string;
  sessionEvents?: Awaited<ReturnType<typeof readSessionLog>>;
}

async function spawnDsh(options: DshRunOptions, compiled: CompiledDshRun, patchPath: string): Promise<SpawnedDsh> {
  const { env } = options;
  const argv = [...env.dshBinArgs, "--profile", env.dshProfile, "--patch", patchPath, compiled.taskPrompt];
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  if (env.dshHome) childEnv["DSH_HOME"] = env.dshHome;

  let stdout = "";
  let stderr = "";
  const child = spawn(env.dshBin, argv, {
    cwd: options.workspaceRoot,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  // PRD 3.14.2 precedence: explicit option > preset.timeoutMs > env default.
  const timeoutMs = options.timeoutMs ?? options.preset.timeoutMs ?? env.apiTimeoutMs;
  let timedOut = false;
  const startedAtMs = Date.now();
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, timeoutMs);

  const { exitCode } = await new Promise<{ exitCode: number | null }>((resolve, reject) => {
    child.stdout!.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr!.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      reject(
        new ClhError("CLH_DSH_NOT_FOUND", `Failed to run dsh binary: ${env.dshBin}`, {
          bin: env.dshBin,
          cause: String(error),
        }),
      );
    });
    child.on("close", (code) => {
      resolve({ exitCode: code });
    });
  });
  if (timer) clearTimeout(timer);

  if (timedOut) {
    throw new ClhError("CLH_API_TIMEOUT", `dsh run exceeded timeoutMs=${timeoutMs}`, {
      timeoutMs,
      elapsedMs: Date.now() - startedAtMs,
      tier: options.preset.model,
      exitCode,
    });
  }
  if (exitCode !== 0) {
    throw new ClhError("CLH_DSH_EXIT", `dsh exited with ${exitCode}: ${tail(stderr || stdout, 400)}`, {
      exitCode,
      stderrTail: tail(stderr, 400),
    });
  }

  const sessionsRoot = env.dshHome ? path.join(env.dshHome, "sessions") : path.join(childEnv["HOME"] ?? "", ".dsh", "sessions");
  const sessionLogPath = await findNewestSessionLog(sessionsRoot, options.workspaceRoot);
  if (!sessionLogPath) {
    throw new ClhError("CLH_SESSION_LOG_UNAVAILABLE", `No durable session log found under ${sessionsRoot}`, {
      sessionsRoot,
      workspaceRoot: options.workspaceRoot,
    });
  }
  const sessionEvents = await readSessionLog(sessionLogPath, env.zstdBin);
  return { exitCode, sessionLogPath, sessionEvents };
}

/**
 * Output-contract enforcement (PRD 3.14.2): precise-json requires the final
 * assistant text to parse as JSON; artifact requires it to be non-empty.
 */
export function enforceOutputContract(
  contract: HarnessPreset["outputContract"],
  finalText: string | undefined,
  toolCalls: number,
): void {
  if (contract === "precise-json") {
    if (!finalText || finalText.trim().length === 0) {
      throw new ClhError("CLH_OUTPUT_CONTRACT", "precise-json contract requires final assistant text", {});
    }
    try {
      JSON.parse(finalText);
    } catch {
      throw new ClhError("CLH_OUTPUT_CONTRACT", "precise-json contract requires the final text to parse as JSON", {});
    }
    return;
  }
  if (contract === "artifact") {
    const hasOutput = (finalText !== undefined && finalText.trim().length > 0) || toolCalls > 0;
    if (!hasOutput) {
      throw new ClhError("CLH_OUTPUT_CONTRACT", "artifact contract requires an artifact or recorded tool calls", {});
    }
  }
}

function tail(text: string, max: number): string {
  return text.length <= max ? text : text.slice(text.length - max);
}
