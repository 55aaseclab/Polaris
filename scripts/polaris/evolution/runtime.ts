import fs from "node:fs";
import path from "node:path";
import type { WorkspaceSpec } from "../core/workspace.js";
import { EvolutionStore } from "./store.js";
import { retrieveEvolutionContext, renderRetrievedArtifacts } from "./retriever.js";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");

function evolutionStateDir(workspace: WorkspaceSpec): string {
  return path.join(REPO_ROOT, "config", "state", "evolution", workspace.identity.projectName);
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function controlPlaneEvolutionDbPath(workspace: WorkspaceSpec): string {
  return path.join(evolutionStateDir(workspace), "store.db");
}

export function controlPlaneEvolutionSnapshotPath(workspace: WorkspaceSpec): string {
  return path.join(evolutionStateDir(workspace), "bootstrap-context.md");
}

function runtimeBootstrapContextPath(workspace: WorkspaceSpec): string {
  return `${workspace.agent.runtime.evolutionRoot}/bootstrap-context.md`;
}

function renderBootstrapContextHeader(workspace: WorkspaceSpec, artifactCount: number): string {
  return [
    "# Polaris Evolution Context",
    "",
    `- project: ${workspace.identity.projectName}`,
    `- manager: ${workspace.agent.managerId}`,
    `- user-profile: ${workspace.userProfile.id}`,
    `- retrieved-artifacts: ${artifactCount}`,
    "",
  ].join("\n");
}

export async function prepareEvolutionBootstrapContext(
  workspace: WorkspaceSpec,
): Promise<WorkspaceSpec> {
  if (!workspace.agent.enabled || !workspace.agent.capabilities.supportsRetrieval) {
    return workspace;
  }

  const dbPath = controlPlaneEvolutionDbPath(workspace);
  const snapshotPath = controlPlaneEvolutionSnapshotPath(workspace);
  ensureDir(path.dirname(dbPath));
  const store = await EvolutionStore.open(dbPath);
  try {
    const artifacts = await retrieveEvolutionContext(store, {
      workspaceId: workspace.identity.projectName,
      userProfileId: workspace.userProfile.id,
      prompt: "",
      limit: 12,
    });
    const rendered = renderRetrievedArtifacts(artifacts);
    const content = `${renderBootstrapContextHeader(workspace, artifacts.length)}${rendered || "_No prior evolution artifacts were retrieved for this workspace yet._\n"}`;
    fs.writeFileSync(snapshotPath, content, "utf8");
    return {
      ...workspace,
      evolution: {
        bootstrapContextFile: runtimeBootstrapContextPath(workspace),
        bootstrapContextContent: content,
        controlPlaneSnapshotPath: snapshotPath,
        artifactCount: artifacts.length,
      },
    };
  } finally {
    store.close();
  }
}
