import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  readHostToolBackendLocks,
  type ToolBackendLock,
  type ToolPrerequisiteKind,
} from "./inventory.js";

export type ToolPrecheckFinding = {
  toolId: string;
  type: "env" | "command" | "python" | "file" | "lock" | "setup";
  key: string;
  kind: ToolPrerequisiteKind;
  reason: string;
  next?: string;
};

export type ToolPrecheckReport = {
  ok: boolean;
  missingRequired: ToolPrecheckFinding[];
  missingRecommended: ToolPrecheckFinding[];
};

function commandExists(name: string): boolean {
  const pathValue = process.env.PATH ?? "";
  return pathValue.split(path.delimiter).some((directory) => {
    try {
      fs.accessSync(path.join(directory, name), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function parsePythonVersion(text: string): [number, number] | null {
  const match = text.match(/Python (\d+)\.(\d+)/u);
  if (!match) return null;
  return [Number(match[1]), Number(match[2])];
}

function parseMinimumVersion(value: string): [number, number] {
  const match = value.trim().match(/^(\d+)\.(\d+)/u);
  if (!match) return [3, 11];
  return [Number(match[1]), Number(match[2])];
}

function versionAtLeast(actual: [number, number], minimum: [number, number]): boolean {
  return actual[0] > minimum[0] || (actual[0] === minimum[0] && actual[1] >= minimum[1]);
}

function pythonStatus(minimumVersion: string, requirements: string[]): string | null {
  const probe = spawnSync("python3", ["--version"], { encoding: "utf8" });
  if (probe.status !== 0) {
    return `python3 ${minimumVersion} is required`;
  }
  const actual = parsePythonVersion(`${probe.stdout}${probe.stderr}`);
  if (!actual || !versionAtLeast(actual, parseMinimumVersion(minimumVersion))) {
    return `python3 ${minimumVersion} is required`;
  }
  if (requirements.length === 0) return null;
  const check = spawnSync(
    "python3",
    ["-c", "import importlib.metadata as m,sys; [m.version(p.split('==')[0].split('>=')[0]) for p in sys.argv[1:]]", ...requirements],
    { encoding: "utf8" },
  );
  if (check.status === 0) return null;
  return `python packages missing: ${requirements.join(", ")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function findingFromScript(toolId: string, item: unknown): ToolPrecheckFinding | null {
  if (!isRecord(item) || typeof item.key !== "string" || typeof item.reason !== "string") {
    return null;
  }
  const type = item.type;
  if (
    type !== "env"
    && type !== "command"
    && type !== "python"
    && type !== "file"
    && type !== "lock"
    && type !== "setup"
  ) {
    return null;
  }
  return {
    toolId,
    type,
    key: item.key,
    kind: item.kind === "required" ? "required" : "recommended",
    reason: item.reason,
    ...(typeof item.next === "string" && item.next.trim() ? { next: item.next } : {}),
  };
}

export function collectLockFindings(
  lock: ToolBackendLock,
  environment: NodeJS.ProcessEnv,
): ToolPrecheckFinding[] {
  const findings: ToolPrecheckFinding[] = [];
  const { toolId, prerequisites } = lock;
  for (const item of prerequisites.env) {
    if (environment[item.key]?.trim()) continue;
    findings.push({
      toolId,
      type: "env",
      key: item.key,
      kind: item.kind,
      reason: item.reason,
    });
  }
  for (const item of prerequisites.commands) {
    if (commandExists(item.name)) continue;
    findings.push({
      toolId,
      type: "command",
      key: item.name,
      kind: item.kind,
      reason: item.reason,
    });
  }
  for (const item of prerequisites.files) {
    const absolute = path.resolve(path.dirname(lock.lockPath), item.path);
    if (fs.existsSync(absolute)) continue;
    findings.push({
      toolId,
      type: "file",
      key: item.path,
      kind: item.kind,
      reason: item.reason,
    });
  }
  if (prerequisites.python) {
    const status = pythonStatus(prerequisites.python.minimum_version, prerequisites.python.requirements);
    if (status) {
      findings.push({
        toolId,
        type: "python",
        key: prerequisites.python.requirements.join(",") || `python3>=${prerequisites.python.minimum_version}`,
        kind: "required",
        reason: status,
      });
    }
  }
  return findings;
}

export function collectToolFindings(
  lock: ToolBackendLock,
  environment: NodeJS.ProcessEnv = process.env,
): ToolPrecheckFinding[] {
  if (!fs.existsSync(lock.checkSetupPath)) {
    return [
      {
        toolId: lock.toolId,
        type: "setup",
        key: "check-setup",
        kind: "required",
        reason: `${lock.toolId} is missing ${lock.checkSetupPath}`,
        next: `Add ${path.dirname(lock.lockPath)}/check-setup so ops tool-precheck can report this tool.`,
      },
    ];
  }
  const probe = spawnSync(lock.checkSetupPath, ["--json"], {
    encoding: "utf8",
    env: { ...environment, POLARIS_TOOL_ID: lock.toolId },
  });
  if (probe.error || probe.status === null) {
    return [
      {
        toolId: lock.toolId,
        type: "setup",
        key: "check-setup",
        kind: "required",
        reason: probe.error instanceof Error ? probe.error.message : `${lock.checkSetupPath} failed to start`,
        next: `Run ${lock.checkSetupPath} --json`,
      },
    ];
  }
  const raw = `${probe.stdout ?? ""}${probe.stderr ?? ""}`.trim();
  try {
    const parsed: unknown = JSON.parse(probe.stdout || "{}");
    if (!isRecord(parsed)) {
      throw new Error("check-setup must print a JSON object");
    }
    const required = Array.isArray(parsed.missingRequired) ? parsed.missingRequired : [];
    const recommended = Array.isArray(parsed.missingRecommended) ? parsed.missingRecommended : [];
    return [...required, ...recommended]
      .map((item) => findingFromScript(lock.toolId, item))
      .filter((item): item is ToolPrecheckFinding => item !== null);
  } catch (error) {
    return [
      {
        toolId: lock.toolId,
        type: "setup",
        key: "check-setup",
        kind: "required",
        reason: error instanceof Error ? error.message : String(error),
        next: raw || `Run ${lock.checkSetupPath} --json`,
      },
    ];
  }
}

export function evaluateToolPrecheck(
  importMetaUrl: string,
  environment: NodeJS.ProcessEnv = process.env,
): ToolPrecheckReport {
  const findings: ToolPrecheckFinding[] = [];
  try {
    for (const lock of readHostToolBackendLocks(importMetaUrl)) {
      findings.push(...collectToolFindings(lock, environment));
    }
  } catch (error) {
    findings.push({
      toolId: "inventory",
      type: "lock",
      key: "backend.lock.json",
      kind: "required",
      reason: error instanceof Error ? error.message : String(error),
    });
  }
  const missingRequired = findings.filter((item) => item.kind === "required");
  const missingRecommended = findings.filter((item) => item.kind === "recommended");
  return {
    ok: missingRequired.length === 0,
    missingRequired,
    missingRecommended,
  };
}

export function formatToolFindingLine(item: ToolPrecheckFinding): string {
  const next = item.next && item.next !== item.reason ? ` — ${item.next}` : "";
  return `${item.kind} ${item.type} ${item.toolId} ${item.key}: ${item.reason}${next}`;
}

export function formatToolSetupLines(toolId: string, findings: ToolPrecheckFinding[]): string[] {
  if (findings.length === 0) {
    return [`${toolId}: setup is complete`];
  }
  return findings.map(formatToolFindingLine);
}

export function formatToolPrecheckLines(report: ToolPrecheckReport): string[] {
  const lines = [...report.missingRequired, ...report.missingRecommended].map(formatToolFindingLine);
  if (lines.length === 0) {
    lines.push("tool prerequisites are complete");
  }
  return lines;
}

export function assertToolPrecheck(
  importMetaUrl: string,
  environment: NodeJS.ProcessEnv = process.env,
): ToolPrecheckReport {
  const report = evaluateToolPrecheck(importMetaUrl, environment);
  if (!report.ok) {
    throw new Error(formatToolPrecheckLines(report).join("\n"));
  }
  return report;
}
