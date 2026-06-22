import fs from "node:fs";
import path from "node:path";
import type { WorkspaceStatus } from "../core/workspace.js";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../../");
const STATE_DIR = path.join(REPO_ROOT, "config", "state");

export interface WorkspaceDriverSelection {
  backend: "docker" | "pod" | "kubevirt-vm";
  profile?: string;
}

function selectionPath(project: string): string {
  return path.join(STATE_DIR, `${project}.selection.json`);
}

export function writeWorkspaceStatus(status: WorkspaceStatus): string {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const outputPath = path.join(STATE_DIR, `${status.project}.status.json`);
  fs.writeFileSync(outputPath, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  return outputPath;
}

export function readWorkspaceDriverSelection(project: string): WorkspaceDriverSelection | null {
  const filePath = selectionPath(project);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as WorkspaceDriverSelection;
  if (parsed.backend !== "docker" && parsed.backend !== "pod" && parsed.backend !== "kubevirt-vm") {
    return null;
  }
  if (parsed.profile !== undefined && typeof parsed.profile !== "string") {
    return null;
  }
  return parsed;
}

export function writeWorkspaceDriverSelection(project: string, selection: WorkspaceDriverSelection): string {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const outputPath = selectionPath(project);
  fs.writeFileSync(outputPath, `${JSON.stringify(selection, null, 2)}\n`, "utf8");
  return outputPath;
}
