import fs from "node:fs";
import path from "node:path";
import type { WorkspaceStatus } from "../core/workspace.js";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../../");

export function writeWorkspaceStatus(status: WorkspaceStatus): string {
  const stateDir = path.join(REPO_ROOT, "config", "state");
  fs.mkdirSync(stateDir, { recursive: true });
  const outputPath = path.join(stateDir, `${status.project}.status.json`);
  fs.writeFileSync(outputPath, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  return outputPath;
}
