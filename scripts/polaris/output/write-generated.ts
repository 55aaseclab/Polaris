import fs from "node:fs";
import path from "node:path";
import type { WorkspaceSpec } from "../core/workspace.js";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");

export function generatedOutputPath(workspace: WorkspaceSpec): string {
  const backendDir =
    workspace.backend.kind === "pod"
      ? "pod"
      : workspace.backend.kind === "kubevirt-vm"
        ? "kubevirt"
        : "docker";
  return path.join(REPO_ROOT, "config", "generated", backendDir, `${workspace.identity.projectName}.yaml`);
}

export function writeGeneratedManifest(workspace: WorkspaceSpec, yamlText: string): string {
  const outputPath = generatedOutputPath(workspace);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, yamlText, "utf8");
  return outputPath;
}
