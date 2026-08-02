import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { VaultSpec } from "../core/vault.js";
import { vaultEvolutionStateDir } from "../output/state-store.js";
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

function userPolarisStateDir(vault: VaultSpec): string {
  return path.join(USER_ROOT, vault.userProfile.id, "polaris");
}

function vaultMemoryStateDir(vault: VaultSpec): string {
  return vaultEvolutionStateDir(
    vault.identity.projectName,
    vault.userProfile.id,
  );
}

function vaultDataMemoryDir(vault: VaultSpec): string {
  return `${vault.attachments.vaultData.mountRoot}/.polaris`;
}

function runtimeSessionsDir(vault: VaultSpec): string {
  return `${vault.agent.runtime.evolutionRoot}/sessions`;
}

function eventsFilePath(vault: VaultSpec): string {
  return path.join(vaultMemoryStateDir(vault), "execution-events.jsonl");
}

export function controlPlaneEvolutionDbPath(vault: VaultSpec): string {
  return path.join(vaultMemoryStateDir(vault), "store.db");
}

function memoryWritePolicy(): "auto" | "stage" {
  return process.env.POLARIS_MEMORY_WRITE_POLICY === "auto" ? "auto" : "stage";
}

function providerFilePath(vault: VaultSpec): string {
  return path.join(userPolarisStateDir(vault), "provider-memory.json");
}

export function controlPlaneVaultMemoryPath(vault: VaultSpec): string {
  return path.join(vaultMemoryStateDir(vault), "MEMORY.md");
}

export function controlPlaneUserMemoryPath(vault: VaultSpec): string {
  return path.join(userPolarisStateDir(vault), "USER.md");
}

export function controlPlanePendingMemoryPath(vault: VaultSpec): string {
  return path.join(vaultMemoryStateDir(vault), "pending-memory.json");
}

export function controlPlaneSessionSnapshotPath(vault: VaultSpec, sessionId = "bootstrap"): string {
  return path.join(vaultMemoryStateDir(vault), "sessions", sessionId, "memory-snapshot.md");
}

function runtimeVaultMemoryPath(vault: VaultSpec): string {
  return `${vaultDataMemoryDir(vault)}/MEMORY.md`;
}

function runtimeUserMemoryPath(vault: VaultSpec): string {
  return `${vault.attachments.userIdentityState.mountRoot}/polaris/USER.md`;
}

function runtimeSessionSnapshotPath(vault: VaultSpec, sessionId = "bootstrap"): string {
  return `${runtimeSessionsDir(vault)}/${sessionId}/memory-snapshot.md`;
}

function writeVaultMemoryFile(vault: VaultSpec, entries: EvolutionMemoryEntry[]): string {
  const filePath = controlPlaneVaultMemoryPath(vault);
  ensureDir(path.dirname(filePath));
  const content = renderMemoryMarkdown({
    heading: "Polaris Vault Memory",
    project: vault.identity.projectName,
    userProfileId: vault.userProfile.id,
    targetLabel: "vault-memory",
    entries,
  });
  fs.writeFileSync(filePath, content, "utf8");
  return content;
}

function writeUserMemoryFile(vault: VaultSpec, entries: EvolutionMemoryEntry[]): string {
  const filePath = controlPlaneUserMemoryPath(vault);
  ensureDir(path.dirname(filePath));
  const content = renderMemoryMarkdown({
    heading: "Polaris User Memory",
    project: vault.identity.projectName,
    userProfileId: vault.userProfile.id,
    targetLabel: "user-memory",
    entries,
  });
  fs.writeFileSync(filePath, content, "utf8");
  return content;
}

function renderSessionSnapshot(params: {
  vault: VaultSpec;
  sessionId: string;
  vaultMemory: string;
  userMemory: string;
  providerMemory: string;
}): string {
  return [
    "# Polaris Memory Snapshot",
    "",
    `- Project: ${params.vault.identity.projectName}`,
    `- User profile: ${params.vault.userProfile.id}`,
    `- Session: ${params.sessionId}`,
    `- Snapshotted at: ${nowIso()}`,
    `- Provider: ${params.providerMemory === "_No external memory provider configured._" ? "disabled" : "enabled"}`,
    "",
    "## Vault Memory",
    "",
    params.vaultMemory,
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

function writeSessionSnapshot(vault: VaultSpec, sessionId: string, content: string): void {
  const filePath = controlPlaneSessionSnapshotPath(vault, sessionId);
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, "utf8");
}

function shouldPersistChange(change: EvolutionMemoryChange): boolean {
  return change.confidence >= 0.55;
}

function writeProviderMirror(vault: VaultSpec, entries: EvolutionMemoryEntry[]): void {
  const providerPath = providerFilePath(vault);
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

function writePendingMemoryFile(vault: VaultSpec, store: EvolutionStore): void {
  writeJsonFile(controlPlanePendingMemoryPath(vault), store.listPendingMemoryChanges(vault.identity.projectName));
}

function mirrorEventsFile(vault: VaultSpec, store: EvolutionStore): void {
  const events = store.listEventsForVault(vault.identity.projectName);
  const filePath = eventsFilePath(vault);
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, events.map((event) => JSON.stringify(event)).join("\n") + (events.length ? "\n" : ""), "utf8");
}

function importMarkdownMemoryIfNeeded(vault: VaultSpec, store: EvolutionStore): void {
  const vaultId = vault.identity.projectName;
  const userProfileId = vault.userProfile.id;
  const hasVaultEntries = store.queryMemoryEntries({
    vaultId,
    target: "vault-memory",
    limit: 1,
  }).length > 0;
  const hasUserEntries = store.queryMemoryEntries({
    vaultId,
    userProfileId,
    target: "user-memory",
    limit: 1,
  }).length > 0;
  if (!hasVaultEntries) {
    const entries = parseMemoryMarkdown({
      filePath: controlPlaneVaultMemoryPath(vault),
      vaultId,
      userProfileId,
      target: "vault-memory",
    });
    for (const entry of entries) {
      store.upsertMemoryEntry(entry);
    }
  }
  if (!hasUserEntries) {
    const entries = parseMemoryMarkdown({
      filePath: controlPlaneUserMemoryPath(vault),
      vaultId,
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
    const existing = store.findActiveMemoryEntry(change.vaultId, change.target, change.key);
    if (existing) {
      store.archiveMemoryEntries([existing.id]);
    }
    store.updatePendingMemoryChangeStatus(change.id, "applied");
    return null;
  }
  if (!change.candidate) {
    return null;
  }
  const existing = store.findActiveMemoryEntry(change.vaultId, change.target, change.key);
  if (existing) {
    store.archiveMemoryEntries([existing.id]);
  }
  const nextEntry: EvolutionMemoryEntry = {
    id: `${change.target}:${change.section}:${change.key}:${randomUUID()}`,
    vaultId: change.vaultId,
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
  vault: VaultSpec,
  sessionId = "bootstrap",
): Promise<VaultSpec> {
  if (!vault.agent.enabled || !vault.agent.capabilities.supportsRetrieval) {
    return vault;
  }
  const store = await EvolutionStore.open(controlPlaneEvolutionDbPath(vault));
  try {
  importMarkdownMemoryIfNeeded(vault, store);
  const vaultEntries = store.queryMemoryEntries({
    vaultId: vault.identity.projectName,
    target: "vault-memory",
    limit: 200,
  });
  const userEntries = store.queryMemoryEntries({
    vaultId: vault.identity.projectName,
    userProfileId: vault.userProfile.id,
    target: "user-memory",
    limit: 200,
  });
  const providerEntries = readProviderMemory(providerFilePath(vault));
  const retrievedVault = await retrieveMemoryContext(vaultEntries, {
    vaultId: vault.identity.projectName,
    userProfileId: vault.userProfile.id,
    prompt: "",
    limit: 12,
  });
  const retrievedUser = await retrieveMemoryContext(userEntries, {
    vaultId: vault.identity.projectName,
    userProfileId: vault.userProfile.id,
    prompt: "",
    limit: 12,
  });
  const vaultContent = writeVaultMemoryFile(vault, retrievedVault);
  const userContent = writeUserMemoryFile(vault, retrievedUser);
  const snapshotContent = renderSessionSnapshot({
    vault,
    sessionId,
    vaultMemory: vaultContent,
    userMemory: userContent,
    providerMemory: renderProviderMemory(providerEntries),
  });
  writeSessionSnapshot(vault, sessionId, snapshotContent);
  writePendingMemoryFile(vault, store);
  return {
    ...vault,
    evolution: {
      vaultMemoryFile: runtimeVaultMemoryPath(vault),
      vaultMemoryContent: vaultContent,
      userMemoryFile: runtimeUserMemoryPath(vault),
      userMemoryContent: userContent,
      sessionSnapshotFile: runtimeSessionSnapshotPath(vault, sessionId),
      sessionSnapshotContent: snapshotContent,
      controlPlaneVaultMemoryPath: controlPlaneVaultMemoryPath(vault),
      controlPlaneUserMemoryPath: controlPlaneUserMemoryPath(vault),
      controlPlaneSessionSnapshotPath: controlPlaneSessionSnapshotPath(vault, sessionId),
      controlPlanePendingMemoryPath: controlPlanePendingMemoryPath(vault),
      artifactCount: retrievedVault.length + retrievedUser.length,
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
  vault: VaultSpec,
  sessionId: string,
  kind: EvolutionExecutionEvent["kind"],
  payload: Record<string, unknown>,
): Promise<void> {
  if (!vault.agent.enabled) {
    return;
  }
  const event = {
    id: randomUUID(),
    vaultId: vault.identity.projectName,
    managerId: vault.agent.managerId,
    sessionId,
    kind,
    timestamp: nowIso(),
    payload,
  };
  const store = await EvolutionStore.open(controlPlaneEvolutionDbPath(vault));
  try {
    store.recordEvent(event);
  } finally {
    store.close();
  }
  appendJsonLine(eventsFilePath(vault), event);
}

export async function finalizeEvolutionSession(
  vault: VaultSpec,
  sessionId: string,
): Promise<void> {
  if (!vault.agent.enabled || !vault.agent.capabilities.supportsReview) {
    return;
  }
  const store = await EvolutionStore.open(controlPlaneEvolutionDbPath(vault));
  try {
  const events = store.listEventsForSession(vault.identity.projectName, sessionId);
  const review = await reviewExecutionCandidate({
    vaultId: vault.identity.projectName,
    userProfileId: vault.userProfile.id,
    managerId: vault.agent.managerId,
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
    const vaultEntries = applyCuratorResult(store.queryMemoryEntries({
      vaultId: vault.identity.projectName,
      target: "vault-memory",
      limit: 200,
    }));
    const userEntries = applyCuratorResult(store.queryMemoryEntries({
      vaultId: vault.identity.projectName,
      userProfileId: vault.userProfile.id,
      target: "user-memory",
      limit: 200,
    }));
    for (const entry of [...vaultEntries, ...userEntries]) {
      store.upsertMemoryEntry(entry);
    }
    writeVaultMemoryFile(vault, vaultEntries.filter((entry) => entry.status === "active"));
    writeUserMemoryFile(vault, userEntries.filter((entry) => entry.status === "active"));
    writeProviderMirror(vault, autoApplied);
  }
  writePendingMemoryFile(vault, store);
  mirrorEventsFile(vault, store);
  } finally {
    store.close();
  }
}

export async function getEvolutionSummary(
  vault: VaultSpec,
): Promise<{
  artifactCount: number;
  activeVaultArtifacts: number;
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
  const store = await EvolutionStore.open(controlPlaneEvolutionDbPath(vault));
  try {
    return store.summarize(vault.identity.projectName, vault.userProfile.id);
  } finally {
    store.close();
  }
}
