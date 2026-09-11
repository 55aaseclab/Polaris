import path from "node:path";
import { repoRelativePath } from "../utils/paths.js";
import {
  readToolInventory,
  readToolBackendLock,
  type ToolBackendLock,
  type ToolInventoryEntry,
} from "./inventory.js";
import { applyHostToolDefaults } from "./defaults.js";
import { collectToolFindings, formatToolSetupLines, type ToolPrecheckFinding } from "./precheck.js";

export type ToolReadiness = "ready" | "warning" | "blocked";

export type PortalToolStatus = {
  id: string;
  entrypoint: string;
  commands: string[];
  capabilities: string[];
  lockPath: string;
  checkSetupPath: string;
  readiness: ToolReadiness;
  prerequisites: ToolBackendLock["prerequisites"];
  checkSetup: {
    ok: boolean;
    lines: string[];
    checked: ToolPrecheckFinding[];
  };
  missingRequired: ToolPrecheckFinding[];
  missingRecommended: ToolPrecheckFinding[];
};

export type PortalToolStatusReport = {
  ok: boolean;
  ready: number;
  warning: number;
  blocked: number;
  tools: PortalToolStatus[];
};

function readinessFor(required: ToolPrecheckFinding[], recommended: ToolPrecheckFinding[]): ToolReadiness {
  if (required.length > 0) return "blocked";
  if (recommended.length > 0) return "warning";
  return "ready";
}

function statusForEntry(
  importMetaUrl: string,
  entry: ToolInventoryEntry,
  environment: NodeJS.ProcessEnv,
): PortalToolStatus {
  try {
    const lock = readToolBackendLock(entry);
    const findings = collectToolFindings(lock, environment);
    const missingRequired = findings.filter((item) => item.kind === "required" && item.status !== "ok");
    const missingRecommended = findings.filter((item) => item.kind === "recommended" && item.status !== "ok");
    return {
      id: entry.id,
      entrypoint: entry.entrypoint,
      commands: entry.commands,
      capabilities: entry.capabilities,
      lockPath: repoRelativePath(importMetaUrl, entry.lockPath),
      checkSetupPath: repoRelativePath(importMetaUrl, lock.checkSetupPath),
      readiness: readinessFor(missingRequired, missingRecommended),
      prerequisites: lock.prerequisites,
      checkSetup: {
        ok: missingRequired.length === 0,
        lines: formatToolSetupLines(entry.id, findings),
        checked: findings,
      },
      missingRequired,
      missingRecommended,
    };
  } catch (error) {
    const finding: ToolPrecheckFinding = {
      toolId: entry.id,
      type: "lock",
      key: "backend.lock.json",
      kind: "required",
      reason: error instanceof Error ? error.message : String(error),
    };
    return {
      id: entry.id,
      entrypoint: entry.entrypoint,
      commands: entry.commands,
      capabilities: entry.capabilities,
      lockPath: repoRelativePath(importMetaUrl, entry.lockPath),
      checkSetupPath: repoRelativePath(importMetaUrl, path.join(entry.directory, "check-setup")),
      readiness: "blocked",
      prerequisites: { env: [], commands: [], files: [] },
      checkSetup: {
        ok: false,
        lines: formatToolSetupLines(entry.id, [finding]),
        checked: [finding],
      },
      missingRequired: [finding],
      missingRecommended: [],
    };
  }
}

export function evaluatePortalToolStatus(
  importMetaUrl: string,
  environment: NodeJS.ProcessEnv = process.env,
): PortalToolStatusReport {
  applyHostToolDefaults(importMetaUrl, environment);
  const tools = readToolInventory(importMetaUrl).map((entry) =>
    statusForEntry(importMetaUrl, entry, environment),
  );
  return {
    ok: tools.every((tool) => tool.readiness !== "blocked"),
    ready: tools.filter((tool) => tool.readiness === "ready").length,
    warning: tools.filter((tool) => tool.readiness === "warning").length,
    blocked: tools.filter((tool) => tool.readiness === "blocked").length,
    tools,
  };
}
