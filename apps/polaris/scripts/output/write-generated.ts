import fs from "node:fs";
import path from "node:path";
import type { WorkspaceSpec } from "../core/workspace.js";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../../");

export function generatedOutputPath(workspace: WorkspaceSpec): string {
  const backendFile =
    workspace.backend.kind === "pod"
      ? "pod.yaml"
      : workspace.backend.kind === "kubevirt-vm"
        ? "kubevirt.yaml"
        : "docker.yaml";
  return path.join(
    REPO_ROOT,
    "config",
    "users",
    workspace.userProfile.id,
    "projects",
    workspace.identity.projectName,
    "generated",
    backendFile,
  );
}

export function writeGeneratedManifest(workspace: WorkspaceSpec, yamlText: string): string {
  const outputPath = generatedOutputPath(workspace);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, yamlText, "utf8");
  return outputPath;
}
