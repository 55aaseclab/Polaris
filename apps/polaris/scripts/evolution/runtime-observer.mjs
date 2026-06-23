import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const paseoHome = process.env.PASEO_HOME || path.join(os.homedir(), ".paseo");
const evolutionRoot = process.env.POLARIS_EVOLUTION_ROOT || path.join(paseoHome, "evolution");
const workspaceDataRoot = process.env.POLARIS_WORKSPACE_DATA_ROOT || "/workspace/project";
const userIdentityRoot = process.env.POLARIS_USER_IDENTITY_ROOT || "/identity";
const workspaceMemoryFile =
  process.env.POLARIS_WORKSPACE_MEMORY_FILE
  || path.join(workspaceDataRoot, ".polaris", "MEMORY.md");
const userMemoryFile =
  process.env.POLARIS_USER_MEMORY_FILE
  || path.join(userIdentityRoot, "polaris", "USER.md");
const sessionSnapshotFile =
  process.env.POLARIS_MEMORY_SNAPSHOT_FILE
  || path.join(evolutionRoot, "sessions", "runtime", "memory-snapshot.md");
const workspaceId = process.env.POLARIS_PROJECT || "workspace";
const userProfileId = process.env.POLARIS_USER_PROFILE_ID || "default";
const managerId = process.env.POLARIS_MANAGER_ID || "paseo";
const agentsRoot = path.join(paseoHome, "agents");
const eventsFile = path.join(evolutionRoot, "execution-events.jsonl");
const candidatesFile = path.join(evolutionRoot, "memory-candidates.jsonl");
const stateFile = path.join(evolutionRoot, "runtime-observer-state.json");
const logPrefix = "[polaris-evolution-observer]";
const pollIntervalMs = 60000;
const memoryLimitDefault = Number(process.env.POLARIS_MEMORY_RECALL_LIMIT || 6);

function log(message, extra) {
  if (extra === undefined) {
    console.error(`${logPrefix} ${message}`);
    return;
  }
  console.error(`${logPrefix} ${message}`, extra);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function appendJsonl(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

function loadObserverState() {
  const state = readJson(stateFile, { agents: {}, memory: {} });
  return {
    agents: typeof state.agents === "object" && state.agents ? state.agents : {},
    memory: typeof state.memory === "object" && state.memory ? state.memory : {},
  };
}

export function shouldPersistMemory(previousStatus, nextStatus) {
  if (nextStatus === "error") {
    return true;
  }
  if (previousStatus == null && nextStatus === "idle") {
    return true;
  }
  return previousStatus === "running" && Boolean(nextStatus) && nextStatus !== "running";
}

export function shouldUseModelSummarizer(status) {
  return status === "error" || status === "idle";
}

function normalizeMemoryEntry(raw) {
  if (!raw || raw.status !== "active") {
    return null;
  }
  return {
    ...raw,
    section: String(raw.section || "Memory"),
    key: String(raw.key || "memory-entry"),
    title: String(raw.title || "Untitled memory"),
    body: String(raw.body || ""),
    updatedAt: String(raw.updatedAt || raw.createdAt || new Date().toISOString()),
    confidence: Number(raw.confidence ?? 0),
  };
}

function entryFingerprint(entry) {
  return JSON.stringify([entry.target, entry.section, entry.key, entry.title, entry.body]);
}

function listRuntimeMemoryCandidates() {
  if (!fs.existsSync(candidatesFile)) {
    return [];
  }
  return fs.readFileSync(candidatesFile, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return normalizeMemoryEntry(JSON.parse(line));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function selectRuntimeMemoryEntries(entries, options = {}) {
  const limit = options.limit ?? memoryLimitDefault;
  const seen = new Set();
  const deduped = [];
  for (const entry of [...entries].sort((left, right) => {
    const confidenceDelta = Number(right.confidence || 0) - Number(left.confidence || 0);
    if (confidenceDelta !== 0) return confidenceDelta;
    return String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""));
  })) {
    const fingerprint = entryFingerprint(entry);
    if (seen.has(fingerprint)) {
      continue;
    }
    seen.add(fingerprint);
    deduped.push(entry);
  }
  return deduped.slice(0, limit);
}

function renderEntrySections(entries, target) {
  const filtered = entries.filter((entry) => entry.target === target);
  if (filtered.length === 0) {
    return "_No runtime-derived memory entries._";
  }
  const bySection = new Map();
  for (const entry of filtered) {
    const bucket = bySection.get(entry.section) ?? [];
    bucket.push(entry);
    bySection.set(entry.section, bucket);
  }
  const lines = [];
  for (const [section, sectionEntries] of bySection.entries()) {
    lines.push(`## ${section}`);
    lines.push("");
    for (const entry of sectionEntries) {
      lines.push(`- \`${entry.key}\` ${entry.title}.`);
      lines.push(`  ${entry.body}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

export function renderWorkspaceMemory(entries) {
  return [
    "# Polaris Workspace Memory",
    "",
    `- Project: ${workspaceId}`,
    `- User profile: ${userProfileId}`,
    `- Target: workspace-memory`,
    "",
    renderEntrySections(entries, "workspace-memory"),
    "",
  ].join("\n");
}

export function renderUserMemory(entries) {
  return [
    "# Polaris User Memory",
    "",
    `- Project: ${workspaceId}`,
    `- User profile: ${userProfileId}`,
    `- Target: user-memory`,
    "",
    renderEntrySections(entries, "user-memory"),
    "",
  ].join("\n");
}

export function renderSessionSnapshot(entries) {
  return [
    "# Polaris Memory Snapshot",
    "",
    `- Project: ${workspaceId}`,
    `- User profile: ${userProfileId}`,
    `- Session: runtime`,
    `- Snapshotted at: ${new Date().toISOString()}`,
    `- Provider: disabled`,
    "",
    "## Workspace Memory",
    "",
    renderEntrySections(entries, "workspace-memory"),
    "",
    "## User Memory",
    "",
    renderEntrySections(entries, "user-memory"),
    "",
    "## Provider Memory",
    "",
    "_No external memory provider configured._",
    "",
  ].join("\n");
}

function makeEvent(sessionId, kind, payload) {
  return {
    id: randomUUID(),
    workspaceId,
    managerId,
    sessionId,
    kind,
    timestamp: new Date().toISOString(),
    payload,
  };
}

function recordEvent(sessionId, kind, payload) {
  appendJsonl(eventsFile, makeEvent(sessionId, kind, payload));
}

export function buildFallbackMemoryChange(record, sessionId) {
  const status = String(record.lastStatus || "");
  if (status === "error") {
    return {
      id: randomUUID(),
      workspaceId,
      userProfileId,
      target: "workspace-memory",
      section: "Environment",
      key: "runtime-failure-pattern",
      title: "Runtime failure recovery",
      body: String(record.lastError || "The runtime exposed a repeatable failure pattern worth remembering."),
      confidence: 0.6,
      status: "active",
      sourceSessionId: sessionId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {
        provider: record.provider ?? "unknown",
        explainability: {
          existsBecause: "Runtime observer captured a durable failure pattern.",
        },
      },
    };
  }
  return {
    id: randomUUID(),
    workspaceId,
    userProfileId,
    target: "user-memory",
    section: "Preferences",
    key: "recent-success-pattern",
    title: "Recent successful workflow",
    body: `Repeat the workflow described by: ${String(record.title || "successful run")}.`,
    confidence: 0.58,
    status: "active",
    sourceSessionId: sessionId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: {
      provider: record.provider ?? "unknown",
      explainability: {
        existsBecause: "Runtime observer captured a successful repeated workflow.",
      },
    },
  };
}

async function summarizeWithCheapModel(record, sessionId) {
  const model = process.env.POLARIS_LESSON_SUMMARIZER_MODEL?.trim();
  const apiKey = process.env.POLARIS_LESSON_SUMMARIZER_API_KEY?.trim();
  const baseUrl = (process.env.POLARIS_LESSON_SUMMARIZER_BASE_URL || "https://api.openai.com/v1").trim().replace(/\/+$/, "");
  if (!model || !apiKey) {
    return null;
  }
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Summarize one engineering run into a durable memory entry. Return strict JSON with keys: target, section, key, title, body, confidence.",
        },
        {
          role: "user",
          content: JSON.stringify({
            workspaceId,
            userProfileId,
            sessionId,
            provider: record.provider ?? "unknown",
            title: record.title ?? null,
            status: record.lastStatus ?? null,
            lastError: record.lastError ?? null,
          }),
        },
      ],
    }),
  });
  if (!response.ok) {
    throw new Error(`summarizer request failed: ${response.status} ${response.statusText}`);
  }
  const body = await response.json();
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    return null;
  }
  const parsed = JSON.parse(content);
  return {
    id: randomUUID(),
    workspaceId,
    userProfileId,
    target: String(parsed.target || "workspace-memory"),
    section: String(parsed.section || "Memory"),
    key: String(parsed.key || "runtime-memory"),
    title: String(parsed.title || "Runtime-derived memory"),
    body: String(parsed.body || ""),
    confidence: Number(parsed.confidence ?? 0.6),
    status: "active",
    sourceSessionId: sessionId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: {
      provider: record.provider ?? "unknown",
      explainability: {
        existsBecause: "Runtime observer model summarizer produced a durable memory entry.",
      },
    },
  };
}

async function buildMemoryEntry(record, sessionId) {
  if (!shouldUseModelSummarizer(String(record.lastStatus || ""))) {
    return null;
  }
  try {
    const modelEntry = await summarizeWithCheapModel(record, sessionId);
    if (modelEntry && modelEntry.body) {
      return modelEntry;
    }
  } catch (error) {
    log("cheap summarizer failed; falling back to deterministic memory", error instanceof Error ? error.message : String(error));
  }
  return buildFallbackMemoryChange(record, sessionId);
}

export async function deriveAgentObservationUpdate(previousStatus, record) {
  const sessionId = String(record.runtimeInfo?.sessionId || record.persistence?.sessionId || record.id);
  const payload = {
    agentId: String(record.id),
    provider: record.provider ?? "unknown",
    cwd: record.cwd ?? null,
    title: record.title ?? null,
    status: record.lastStatus ?? null,
    lastError: record.lastError ?? null,
    updatedAt: record.updatedAt ?? null,
  };
  const events = [{ kind: "task-output", payload }];
  const nextStatus = record.lastStatus ?? null;
  const completedBeforeFirstPoll =
    previousStatus == null &&
    nextStatus === "idle" &&
    (record.attentionReason === "finished" || record.requiresAttention === true);
  if (nextStatus === "running" && previousStatus !== "running") {
    events.push({ kind: "task-started", payload });
  } else if (nextStatus === "error" && previousStatus !== "error") {
    events.push({ kind: "task-failed", payload });
  } else if (
    completedBeforeFirstPoll ||
    (previousStatus === "running" && nextStatus && nextStatus !== "running" && nextStatus !== "error")
  ) {
    events.push({ kind: "task-completed", payload });
  }
  const memoryEntry = shouldPersistMemory(previousStatus, nextStatus)
    ? await buildMemoryEntry(record, sessionId)
    : null;
  return { sessionId, payload, events, memoryEntry };
}

function recordMemory(state, sessionId, entry) {
  const signature = `${sessionId}:${entry.target}:${entry.key}`;
  if (state.memory[signature]) {
    return false;
  }
  appendJsonl(candidatesFile, entry);
  state.memory[signature] = entry.id;
  return true;
}

function agentFingerprint(record) {
  return JSON.stringify({
    updatedAt: record.updatedAt ?? null,
    lastStatus: record.lastStatus ?? null,
    lastError: record.lastError ?? null,
    lastActivityAt: record.lastActivityAt ?? null,
  });
}

function listAgentRecords() {
  const records = [];
  if (!fs.existsSync(agentsRoot)) {
    return records;
  }
  for (const workspaceEntry of fs.readdirSync(agentsRoot, { withFileTypes: true })) {
    if (!workspaceEntry.isDirectory()) {
      continue;
    }
    const workspaceDir = path.join(agentsRoot, workspaceEntry.name);
    for (const entry of fs.readdirSync(workspaceDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }
      const filePath = path.join(workspaceDir, entry.name);
      try {
        records.push(JSON.parse(fs.readFileSync(filePath, "utf8")));
      } catch {
        continue;
      }
    }
  }
  return records;
}

async function maybeRecordAgentChange(state, record) {
  if (!record || typeof record !== "object" || !record.id) {
    return false;
  }
  const key = String(record.id);
  const previous = state.agents[key];
  const fingerprint = agentFingerprint(record);
  if (previous?.fingerprint === fingerprint) {
    return false;
  }
  const previousStatus = previous?.lastStatus ?? null;
  const nextStatus = record.lastStatus ?? null;
  const derived = await deriveAgentObservationUpdate(previousStatus, record);
  for (const event of derived.events) {
    recordEvent(derived.sessionId, event.kind, event.payload);
  }
  if (derived.memoryEntry) {
    recordMemory(state, derived.sessionId, derived.memoryEntry);
  }
  state.agents[key] = {
    fingerprint,
    lastStatus: nextStatus,
  };
  return true;
}

async function poll() {
  const state = loadObserverState();
  let changed = false;
  for (const record of listAgentRecords()) {
    if (await maybeRecordAgentChange(state, record)) {
      changed = true;
    }
  }
  if (changed) {
    writeJson(stateFile, state);
  }
}

export async function main() {
  ensureDir(evolutionRoot);
  log("starting observer", {
    paseoHome,
    evolutionRoot,
    workspaceMemoryFile,
    userMemoryFile,
    sessionSnapshotFile,
    workspaceId,
    userProfileId,
    managerId,
    pollIntervalMs,
  });
  await poll();
  setInterval(() => {
    void poll().catch((error) => {
      log("poll failed", error instanceof Error ? error.message : String(error));
    });
  }, pollIntervalMs);
}

const isMainModule = typeof process.argv[1] === "string" && process.argv[1].endsWith("runtime-observer.mjs");

if (isMainModule) {
  void main().catch((error) => {
    log("observer crashed", error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
