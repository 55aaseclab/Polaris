import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { WorkspaceSpec } from "../core/workspace.js";
import { EvolutionStore } from "./store.js";
import { retrieveEvolutionContext, renderRetrievedArtifacts } from "./retriever.js";
import { reviewExecutionCandidate } from "./reviewer.js";
import { applyCuratorResult } from "./curator.js";
import type { EvolutionExecutionEvent } from "./types.js";

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

function nowIso(): string {
  return new Date().toISOString();
}

export function createEvolutionSessionId(command: string): string {
  return `${command}-${randomUUID()}`;
}

export async function appendEvolutionEvent(
  workspace: WorkspaceSpec,
  sessionId: string,
  kind: EvolutionExecutionEvent["kind"],
  payload: Record<string, unknown>,
): Promise<void> {
  if (!workspace.agent.enabled) {
    return;
  }
  const store = await EvolutionStore.open(controlPlaneEvolutionDbPath(workspace));
  try {
    store.recordEvent({
      id: randomUUID(),
      workspaceId: workspace.identity.projectName,
      managerId: workspace.agent.managerId,
      sessionId,
      kind,
      timestamp: nowIso(),
      payload,
    });
  } finally {
    store.close();
  }
}

export async function finalizeEvolutionSession(
  workspace: WorkspaceSpec,
  sessionId: string,
): Promise<void> {
  if (!workspace.agent.enabled || !workspace.agent.capabilities.supportsReview) {
    return;
  }
  const store = await EvolutionStore.open(controlPlaneEvolutionDbPath(workspace));
  try {
    const events = store.listEventsForSession(workspace.identity.projectName, sessionId);
    const review = await reviewExecutionCandidate({
      workspaceId: workspace.identity.projectName,
      userProfileId: workspace.userProfile.id,
      managerId: workspace.agent.managerId,
      sessionId,
      events,
    });
    for (const artifact of review.artifacts) {
      store.upsertArtifact(artifact);
    }
    applyCuratorResult(store, review.artifacts);
  } finally {
    store.close();
  }
}

export async function getEvolutionSummary(
  workspace: WorkspaceSpec,
): Promise<{
  artifactCount: number;
  activeWorkspaceArtifacts: number;
  activeUserArtifacts: number;
  latestTitles: string[];
  latestArtifacts: Array<{
    title: string;
    kind: string;
    status: string;
    whyExists?: string;
    whyRetrieved?: string[];
    curatorAction?: string;
    curatorReason?: string;
    suppressedBecause?: string;
  }>;
}> {
  const store = await EvolutionStore.open(controlPlaneEvolutionDbPath(workspace));
  try {
    return store.summarize(workspace.identity.projectName, workspace.userProfile.id);
  } finally {
    store.close();
  }
}
