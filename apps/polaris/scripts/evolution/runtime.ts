import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { WorkspaceSpec } from "../core/workspace.js";
import { workspaceEvolutionStateDir } from "../output/state-store.js";
import { polarisUsersRoot } from "../utils/paths.js";
import { applyCuratorResult } from "./curator.js";
import {
  appendJsonLine,
  ensureDir,
  nowIso,
  parseMemoryMarkdown,
  readProviderMemory,
  renderMemoryMarkdown,
  writeJsonFile,
} from "./files.js";
import { reviewExecutionCandidate } from "./reviewer.js";
import { renderProviderMemory, retrieveMemoryContext } from "./retriever.js";
import { EvolutionStore } from "./store.js";
import type {
  EvolutionExecutionEvent,
  EvolutionMemoryChange,
  EvolutionMemoryEntry,
  EvolutionMemoryProviderEntry,
} from "./types.js";

const USER_ROOT = polarisUsersRoot(import.meta.url);

function userPolarisStateDir(workspace: WorkspaceSpec): string {
  return path.join(USER_ROOT, workspace.userProfile.id, "polaris");
}

function workspaceMemoryStateDir(workspace: WorkspaceSpec): string {
  return workspaceEvolutionStateDir(
    workspace.identity.projectName,
    workspace.userProfile.id,
  );
}

function workspaceDataMemoryDir(workspace: WorkspaceSpec): string {
  return `${workspace.attachments.workspaceData.mountRoot}/.polaris`;
}

function runtimeSessionsDir(workspace: WorkspaceSpec): string {
  return `${workspace.agent.runtime.evolutionRoot}/sessions`;
}

function eventsFilePath(workspace: WorkspaceSpec): string {
  return path.join(workspaceMemoryStateDir(workspace), "execution-events.jsonl");
}

export function controlPlaneEvolutionDbPath(workspace: WorkspaceSpec): string {
  return path.join(workspaceMemoryStateDir(workspace), "store.db");
}

function memoryWritePolicy(): "auto" | "stage" {
  return process.env.POLARIS_MEMORY_WRITE_POLICY === "auto" ? "auto" : "stage";
}

function providerFilePath(workspace: WorkspaceSpec): string {
  return path.join(userPolarisStateDir(workspace), "provider-memory.json");
}

export function controlPlaneWorkspaceMemoryPath(workspace: WorkspaceSpec): string {
  return path.join(workspaceMemoryStateDir(workspace), "MEMORY.md");
}

export function controlPlaneUserMemoryPath(workspace: WorkspaceSpec): string {
  return path.join(userPolarisStateDir(workspace), "USER.md");
}

export function controlPlanePendingMemoryPath(workspace: WorkspaceSpec): string {
  return path.join(workspaceMemoryStateDir(workspace), "pending-memory.json");
}

export function controlPlaneSessionSnapshotPath(workspace: WorkspaceSpec, sessionId = "bootstrap"): string {
  return path.join(workspaceMemoryStateDir(workspace), "sessions", sessionId, "memory-snapshot.md");
}

function runtimeWorkspaceMemoryPath(workspace: WorkspaceSpec): string {
  return `${workspaceDataMemoryDir(workspace)}/MEMORY.md`;
}

function runtimeUserMemoryPath(workspace: WorkspaceSpec): string {
  return `${workspace.attachments.userIdentityState.mountRoot}/polaris/USER.md`;
}

function runtimeSessionSnapshotPath(workspace: WorkspaceSpec, sessionId = "bootstrap"): string {
  return `${runtimeSessionsDir(workspace)}/${sessionId}/memory-snapshot.md`;
}

function writeWorkspaceMemoryFile(workspace: WorkspaceSpec, entries: EvolutionMemoryEntry[]): string {
  const filePath = controlPlaneWorkspaceMemoryPath(workspace);
  ensureDir(path.dirname(filePath));
  const content = renderMemoryMarkdown({
    heading: "Polaris Workspace Memory",
    project: workspace.identity.projectName,
    userProfileId: workspace.userProfile.id,
    targetLabel: "workspace-memory",
    entries,
  });
  fs.writeFileSync(filePath, content, "utf8");
  return content;
}

function writeUserMemoryFile(workspace: WorkspaceSpec, entries: EvolutionMemoryEntry[]): string {
  const filePath = controlPlaneUserMemoryPath(workspace);
  ensureDir(path.dirname(filePath));
  const content = renderMemoryMarkdown({
    heading: "Polaris User Memory",
    project: workspace.identity.projectName,
    userProfileId: workspace.userProfile.id,
    targetLabel: "user-memory",
    entries,
  });
  fs.writeFileSync(filePath, content, "utf8");
  return content;
}

function renderSessionSnapshot(params: {
  workspace: WorkspaceSpec;
  sessionId: string;
  workspaceMemory: string;
  userMemory: string;
  providerMemory: string;
}): string {
  return [
    "# Polaris Memory Snapshot",
    "",
    `- Project: ${params.workspace.identity.projectName}`,
    `- User profile: ${params.workspace.userProfile.id}`,
    `- Session: ${params.sessionId}`,
    `- Snapshotted at: ${nowIso()}`,
    `- Provider: ${params.providerMemory === "_No external memory provider configured._" ? "disabled" : "enabled"}`,
    "",
    "## Workspace Memory",
    "",
    params.workspaceMemory,
    "",
    "## User Memory",
    "",
    params.userMemory,
    "",
    "## Provider Memory",
    "",
    params.providerMemory,
    "",
  ].join("\n");
}

function writeSessionSnapshot(workspace: WorkspaceSpec, sessionId: string, content: string): void {
  const filePath = controlPlaneSessionSnapshotPath(workspace, sessionId);
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, "utf8");
}

function shouldPersistChange(change: EvolutionMemoryChange): boolean {
  return change.confidence >= 0.55;
}

function writeProviderMirror(workspace: WorkspaceSpec, entries: EvolutionMemoryEntry[]): void {
  const providerPath = providerFilePath(workspace);
  ensureDir(path.dirname(providerPath));
  const current = readProviderMemory(providerPath);
  const next = [...current];
  for (const entry of entries) {
    next.push({
      source: "local-memory-sync",
      title: entry.title,
      body: entry.body,
      score: entry.confidence,
    });
  }
  writeJsonFile(providerPath, next);
}

function writePendingMemoryFile(workspace: WorkspaceSpec, store: EvolutionStore): void {
  writeJsonFile(controlPlanePendingMemoryPath(workspace), store.listPendingMemoryChanges(workspace.identity.projectName));
}

function mirrorEventsFile(workspace: WorkspaceSpec, store: EvolutionStore): void {
  const events = store.listEventsForWorkspace(workspace.identity.projectName);
  const filePath = eventsFilePath(workspace);
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, events.map((event) => JSON.stringify(event)).join("\n") + (events.length ? "\n" : ""), "utf8");
}

function importMarkdownMemoryIfNeeded(workspace: WorkspaceSpec, store: EvolutionStore): void {
  const workspaceId = workspace.identity.projectName;
  const userProfileId = workspace.userProfile.id;
  const hasWorkspaceEntries = store.queryMemoryEntries({
    workspaceId,
    target: "workspace-memory",
    limit: 1,
  }).length > 0;
  const hasUserEntries = store.queryMemoryEntries({
    workspaceId,
    userProfileId,
    target: "user-memory",
    limit: 1,
  }).length > 0;
  if (!hasWorkspaceEntries) {
    const entries = parseMemoryMarkdown({
      filePath: controlPlaneWorkspaceMemoryPath(workspace),
      workspaceId,
      userProfileId,
      target: "workspace-memory",
    });
    for (const entry of entries) {
      store.upsertMemoryEntry(entry);
    }
  }
  if (!hasUserEntries) {
    const entries = parseMemoryMarkdown({
      filePath: controlPlaneUserMemoryPath(workspace),
      workspaceId,
      userProfileId,
      target: "user-memory",
    });
    for (const entry of entries) {
      store.upsertMemoryEntry(entry);
    }
  }
}

function applyMemoryChange(store: EvolutionStore, change: EvolutionMemoryChange): EvolutionMemoryEntry | null {
  if (change.operation === "remove") {
    const existing = store.findActiveMemoryEntry(change.workspaceId, change.target, change.key);
    if (existing) {
      store.archiveMemoryEntries([existing.id]);
    }
    store.updatePendingMemoryChangeStatus(change.id, "applied");
    return null;
  }
  if (!change.candidate) {
    return null;
  }
  const existing = store.findActiveMemoryEntry(change.workspaceId, change.target, change.key);
  if (existing) {
    store.archiveMemoryEntries([existing.id]);
  }
  const nextEntry: EvolutionMemoryEntry = {
    id: `${change.target}:${change.section}:${change.key}:${randomUUID()}`,
    workspaceId: change.workspaceId,
    userProfileId: change.userProfileId,
    target: change.target,
    section: change.section,
    key: change.key,
    title: change.candidate.title,
    body: change.candidate.body,
    confidence: change.confidence,
    status: "active",
    sourceSessionId: change.sourceSessionId,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    metadata: {
      ...change.metadata,
      explainability: {
        existsBecause: change.reason,
      },
    },
  };
  store.upsertMemoryEntry(nextEntry);
  store.updatePendingMemoryChangeStatus(change.id, "applied");
  return nextEntry;
}

export async function prepareEvolutionMemorySnapshot(
  workspace: WorkspaceSpec,
  sessionId = "bootstrap",
): Promise<WorkspaceSpec> {
  if (!workspace.agent.enabled || !workspace.agent.capabilities.supportsRetrieval) {
    return workspace;
  }
  const store = await EvolutionStore.open(controlPlaneEvolutionDbPath(workspace));
  try {
  importMarkdownMemoryIfNeeded(workspace, store);
  const workspaceEntries = store.queryMemoryEntries({
    workspaceId: workspace.identity.projectName,
    target: "workspace-memory",
    limit: 200,
  });
  const userEntries = store.queryMemoryEntries({
    workspaceId: workspace.identity.projectName,
    userProfileId: workspace.userProfile.id,
    target: "user-memory",
    limit: 200,
  });
  const providerEntries = readProviderMemory(providerFilePath(workspace));
  const retrievedWorkspace = await retrieveMemoryContext(workspaceEntries, {
    workspaceId: workspace.identity.projectName,
    userProfileId: workspace.userProfile.id,
    prompt: "",
    limit: 12,
  });
  const retrievedUser = await retrieveMemoryContext(userEntries, {
    workspaceId: workspace.identity.projectName,
    userProfileId: workspace.userProfile.id,
    prompt: "",
    limit: 12,
  });
  const workspaceContent = writeWorkspaceMemoryFile(workspace, retrievedWorkspace);
  const userContent = writeUserMemoryFile(workspace, retrievedUser);
  const snapshotContent = renderSessionSnapshot({
    workspace,
    sessionId,
    workspaceMemory: workspaceContent,
    userMemory: userContent,
    providerMemory: renderProviderMemory(providerEntries),
  });
  writeSessionSnapshot(workspace, sessionId, snapshotContent);
  writePendingMemoryFile(workspace, store);
  return {
    ...workspace,
    evolution: {
      workspaceMemoryFile: runtimeWorkspaceMemoryPath(workspace),
      workspaceMemoryContent: workspaceContent,
      userMemoryFile: runtimeUserMemoryPath(workspace),
      userMemoryContent: userContent,
      sessionSnapshotFile: runtimeSessionSnapshotPath(workspace, sessionId),
      sessionSnapshotContent: snapshotContent,
      controlPlaneWorkspaceMemoryPath: controlPlaneWorkspaceMemoryPath(workspace),
      controlPlaneUserMemoryPath: controlPlaneUserMemoryPath(workspace),
      controlPlaneSessionSnapshotPath: controlPlaneSessionSnapshotPath(workspace, sessionId),
      controlPlanePendingMemoryPath: controlPlanePendingMemoryPath(workspace),
      artifactCount: retrievedWorkspace.length + retrievedUser.length,
    },
  };
  } finally {
    store.close();
  }
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
  const event = {
    id: randomUUID(),
    workspaceId: workspace.identity.projectName,
    managerId: workspace.agent.managerId,
    sessionId,
    kind,
    timestamp: nowIso(),
    payload,
  };
  const store = await EvolutionStore.open(controlPlaneEvolutionDbPath(workspace));
  try {
    store.recordEvent(event);
  } finally {
    store.close();
  }
  appendJsonLine(eventsFilePath(workspace), event);
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
  const autoApplied: EvolutionMemoryEntry[] = [];
  for (const change of review.changes) {
    if (!shouldPersistChange(change)) {
      continue;
    }
    const nextChange: EvolutionMemoryChange = {
      ...change,
      status: memoryWritePolicy() === "auto" ? "approved" : "pending",
      updatedAt: nowIso(),
    };
    store.savePendingMemoryChange(nextChange);
    if (memoryWritePolicy() === "auto") {
      const applied = applyMemoryChange(store, nextChange);
      if (applied) {
        autoApplied.push(applied);
      }
    }
  }
  if (autoApplied.length > 0) {
    const workspaceEntries = applyCuratorResult(store.queryMemoryEntries({
      workspaceId: workspace.identity.projectName,
      target: "workspace-memory",
      limit: 200,
    }));
    const userEntries = applyCuratorResult(store.queryMemoryEntries({
      workspaceId: workspace.identity.projectName,
      userProfileId: workspace.userProfile.id,
      target: "user-memory",
      limit: 200,
    }));
    for (const entry of [...workspaceEntries, ...userEntries]) {
      store.upsertMemoryEntry(entry);
    }
    writeWorkspaceMemoryFile(workspace, workspaceEntries.filter((entry) => entry.status === "active"));
    writeUserMemoryFile(workspace, userEntries.filter((entry) => entry.status === "active"));
    writeProviderMirror(workspace, autoApplied);
  }
  writePendingMemoryFile(workspace, store);
  mirrorEventsFile(workspace, store);
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
  pendingMemoryChanges: number;
}> {
  const store = await EvolutionStore.open(controlPlaneEvolutionDbPath(workspace));
  try {
    return store.summarize(workspace.identity.projectName, workspace.userProfile.id);
  } finally {
    store.close();
  }
}
