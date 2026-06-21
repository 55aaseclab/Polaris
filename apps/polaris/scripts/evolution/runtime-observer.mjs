import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const paseoHome = process.env.PASEO_HOME || path.join(os.homedir(), ".paseo");
const evolutionRoot = process.env.POLARIS_EVOLUTION_ROOT || path.join(paseoHome, "evolution");
const contextFile = process.env.POLARIS_EVOLUTION_CONTEXT_FILE || path.join(evolutionRoot, "bootstrap-context.md");
const toolRoot = process.env.POLARIS_TOOL_ROOT || path.join(os.homedir(), ".local", "polaris");
const daemonUrl = process.env.POLARIS_PASEO_DAEMON_URL || "ws://127.0.0.1:6767/ws";
const workspaceId = process.env.POLARIS_PROJECT || "workspace";
const userProfileId = process.env.POLARIS_USER_PROFILE_ID || "default";
const managerId = process.env.POLARIS_MANAGER_ID || "paseo";
const agentsRoot = path.join(paseoHome, "agents");
const eventsFile = path.join(evolutionRoot, "execution-events.jsonl");
const artifactsFile = path.join(evolutionRoot, "artifacts.jsonl");
const stateFile = path.join(evolutionRoot, "runtime-observer-state.json");
const logPrefix = "[polaris-evolution-observer]";
const pollIntervalMs = 60000;
const lessonLimitDefault = Number(process.env.POLARIS_LESSON_RECALL_LIMIT || 3);

function normalizeBootstrapSeed(raw) {
  const source = String(raw || "").trim();
  if (!source) {
    return "";
  }
  const runtimeMarker = "\n# Polaris Runtime Lessons";
  const runtimeIndex = source.indexOf(runtimeMarker);
  if (runtimeIndex === -1) {
    return `${source}\n`;
  }
  return `${source.slice(0, runtimeIndex).trimEnd()}\n`;
}

let bootstrapSeed = normalizeBootstrapSeed(fs.existsSync(contextFile) ? fs.readFileSync(contextFile, "utf8") : "");
let lastRenderedContext = bootstrapSeed;
let lastAppendedPrompt = "";
let paseoClient = null;
let createPaseoClient = null;
let cachedArtifactsStatKey = "";
let cachedArtifacts = [];

function includesAny(source, markers) {
  return markers.some((marker) => source.includes(marker));
}

export function parseTriggerFlags(text) {
  const source = String(text || "");
  return {
    learn: includesAny(source, [
      "POLARIS-LEARN-IT",
      "POLARIS_LEARN_IT",
      "POLARIS-LEARNT-IT",
      "POLARIS_LEARNT_IT",
    ]),
    recall: includesAny(source, [
      "POLARIS-RECALL",
      "POLARIS_RECALL",
    ]),
    dontLearn: includesAny(source, [
      "POLARIS-DONT-LEARN",
      "POLARIS_DONT_LEARN",
    ]),
    ephemeral: includesAny(source, [
      "POLARIS-EPHEMERAL",
      "POLARIS_EPHEMERAL",
    ]),
  };
}

export function shouldPersistLesson(triggerFlags, previousStatus, nextStatus) {
  if (triggerFlags.dontLearn || triggerFlags.ephemeral) {
    return false;
  }
  if (triggerFlags.learn) {
    return true;
  }
  if (nextStatus === "error") {
    return true;
  }
  if (previousStatus == null && nextStatus === "idle") {
    return true;
  }
  return previousStatus === "running" && Boolean(nextStatus) && nextStatus !== "running" && nextStatus !== "error";
}

export function shouldUseModelSummarizer(triggerFlags, status) {
  return triggerFlags.learn || status === "error" || status === "idle";
}

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
  const state = readJson(stateFile, { agents: {}, artifacts: {} });
  return {
    agents: typeof state.agents === "object" && state.agents ? state.agents : {},
    artifacts: typeof state.artifacts === "object" && state.artifacts ? state.artifacts : {},
  };
}

function normalizeLessonArtifact(raw) {
  if (!raw || raw.status !== "active") {
    return null;
  }
  const metadata = typeof raw.metadata === "object" && raw.metadata ? raw.metadata : {};
  const tags = Array.isArray(metadata.tags) ? metadata.tags.map((tag) => String(tag)) : [];
  return {
    ...raw,
    title: String(raw.title || "Untitled lesson"),
    content: String(raw.content || ""),
    metadata: {
      ...metadata,
      summary: String(metadata.summary || raw.content || ""),
      whenToUse: String(metadata.whenToUse || ""),
      tags,
      trigger: metadata.trigger ? String(metadata.trigger) : undefined,
    },
    updatedAt: String(raw.updatedAt || raw.createdAt || new Date().toISOString()),
    confidence: Number(raw.confidence ?? 0),
  };
}

function artifactFingerprint(artifact) {
  const summary = String(artifact.metadata?.summary || artifact.content || "").trim();
  const whenToUse = String(artifact.metadata?.whenToUse || "").trim();
  const tags = Array.isArray(artifact.metadata?.tags) ? artifact.metadata.tags.join(",") : "";
  return JSON.stringify([
    String(artifact.kind || "lesson"),
    String(artifact.title || "").trim(),
    summary,
    whenToUse,
    tags,
  ]);
}

function listRuntimeArtifacts() {
  if (!fs.existsSync(artifactsFile)) {
    cachedArtifactsStatKey = "";
    cachedArtifacts = [];
    return [];
  }
  const stats = fs.statSync(artifactsFile);
  const statKey = `${stats.size}:${stats.mtimeMs}`;
  if (statKey === cachedArtifactsStatKey) {
    return cachedArtifacts;
  }
  const lines = fs.readFileSync(artifactsFile, "utf8").split(/\r?\n/).filter(Boolean);
  const artifacts = [];
  for (const line of lines) {
    try {
      const normalized = normalizeLessonArtifact(JSON.parse(line));
      if (normalized) {
        artifacts.push(normalized);
      }
    } catch {
      continue;
    }
  }
  cachedArtifactsStatKey = statKey;
  cachedArtifacts = artifacts;
  return artifacts;
}

export function selectRuntimeLessons(artifacts, options = {}) {
  const recallRequested = Boolean(options.recallRequested);
  const limit = recallRequested ? Math.max(lessonLimitDefault * 2, lessonLimitDefault) : lessonLimitDefault;
  const seen = new Set();
  const deduped = [];
  for (const artifact of [...artifacts].sort((left, right) => {
    const confidenceDelta = Number(right.confidence || 0) - Number(left.confidence || 0);
    if (confidenceDelta !== 0) return confidenceDelta;
    return String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""));
  })) {
    const fingerprint = artifactFingerprint(artifact);
    if (seen.has(fingerprint)) {
      continue;
    }
    seen.add(fingerprint);
    deduped.push(artifact);
  }
  return deduped
    .slice(0, limit);
}

export function renderContext(artifacts, options = {}) {
  const relevant = selectRuntimeLessons(artifacts, options);
  const sections = [];
  if (bootstrapSeed.trim()) {
    sections.push(bootstrapSeed.trimEnd());
  }
  if (relevant.length > 0) {
    const lines = [
      "# Polaris Runtime Lessons",
      "",
      `- project: ${workspaceId}`,
      `- manager: ${managerId}`,
      `- user-profile: ${userProfileId}`,
      `- runtime-artifacts: ${relevant.length}`,
      "",
      "Relevant runtime lessons:",
    ];
    for (const artifact of relevant) {
      const kind = String(artifact.kind || "lesson");
      const title = String(artifact.title || "Untitled lesson").trim() || "Untitled lesson";
      const summary = String(artifact.metadata?.summary || artifact.content || "").trim() || "No summary recorded.";
      const whenToUse = String(artifact.metadata?.whenToUse || "").trim();
      const tags = Array.isArray(artifact.metadata?.tags) && artifact.metadata.tags.length > 0
        ? ` Tags: ${artifact.metadata.tags.join(", ")}.`
        : "";
      lines.push(`- [${kind}] ${title}: ${summary}${whenToUse ? ` Use when: ${whenToUse}.` : ""}${tags}`);
    }
    sections.push(lines.join("\n"));
  }
  if (sections.length === 0) {
    sections.push(
      [
        "# Polaris Evolution Context",
        "",
        `- project: ${workspaceId}`,
        `- manager: ${managerId}`,
        `- user-profile: ${userProfileId}`,
        `- retrieved-artifacts: 0`,
        "",
        "_No prior evolution artifacts were retrieved for this workspace yet._",
      ].join("\n"),
    );
  }
  return `${sections.join("\n\n")}\n`;
}

async function ensurePaseoClient() {
  if (paseoClient) {
    return paseoClient;
  }
  if (!createPaseoClient) {
    if (!globalThis.WebSocket) {
      const wsEntry = path.join(
        toolRoot,
        "lib",
        "node_modules",
        "@getpaseo",
        "cli",
        "node_modules",
        "ws",
        "wrapper.mjs",
      );
      const wsModule = await import(pathToFileURL(wsEntry).href);
      globalThis.WebSocket = wsModule.default;
    }
    const clientEntry = path.join(
      toolRoot,
      "lib",
      "node_modules",
      "@getpaseo",
      "cli",
      "node_modules",
      "@getpaseo",
      "client",
      "dist",
      "index.js",
    );
    ({ createPaseoClient } = await import(pathToFileURL(clientEntry).href));
  }
  paseoClient = createPaseoClient({
    url: daemonUrl,
    clientId: `polaris-evolution-${workspaceId}`,
  });
  await paseoClient.connect();
  return paseoClient;
}

async function patchDaemonAppendSystemPrompt(content) {
  const nextPrompt = content.trim()
    ? `Use this Polaris evolution context if it is relevant to the task.\n\n${content.trim()}`
    : "";
  if (nextPrompt === lastAppendedPrompt) {
    return;
  }
  try {
    const client = await ensurePaseoClient();
    await client.config.patch({ appendSystemPrompt: nextPrompt });
    lastAppendedPrompt = nextPrompt;
  } catch (error) {
    log("failed to patch daemon appendSystemPrompt", error instanceof Error ? error.message : String(error));
  }
}

function writeContextAndPatch(artifacts, options = {}) {
  const rendered = renderContext(artifacts, options);
  if (rendered !== lastRenderedContext) {
    ensureDir(path.dirname(contextFile));
    fs.writeFileSync(contextFile, rendered, "utf8");
    lastRenderedContext = rendered;
  }
  return patchDaemonAppendSystemPrompt(rendered);
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

function buildDefaultTags(record, triggerFlags) {
  const tags = new Set();
  if (record.provider) tags.add(String(record.provider));
  if (record.cwd) {
    for (const token of String(record.cwd).split(/[\/._-]+/).filter(Boolean)) {
      if (token.length > 1) tags.add(token);
    }
  }
  if (record.lastError) {
    for (const token of String(record.lastError).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
      if (token.length > 2) tags.add(token);
    }
  }
  if (triggerFlags.learn) tags.add("learn");
  if (triggerFlags.recall) tags.add("recall");
  return [...tags].slice(0, 8);
}

export function buildFallbackLesson(record, sessionId, triggerFlags) {
  const status = String(record.lastStatus || "");
  const provider = String(record.provider || "agent");
  const title = String(record.title || "").trim() || "Recovered lesson";
  const detail = String(record.lastError || "").trim();
  if (status === "error") {
    return {
      kind: "lesson",
      title: `Recovered failure lesson (${provider})`,
      summary: detail || "The run failed and produced a durable troubleshooting lesson.",
      whenToUse: `Use when ${provider} shows the same failure pattern in this workspace`,
      tags: buildDefaultTags(record, triggerFlags),
      confidence: triggerFlags.learn ? 0.8 : 0.6,
      trigger: triggerFlags.learn ? "POLARIS-LEARN-IT" : "automatic-failure",
      sourceSessionId: sessionId,
    };
  }
  return {
    kind: "lesson",
    title: `Recovered workflow lesson (${provider})`,
    summary: title,
    whenToUse: `Use when repeating a similar ${provider} task in this workspace`,
    tags: buildDefaultTags(record, triggerFlags),
    confidence: triggerFlags.learn ? 0.85 : 0.6,
    trigger: triggerFlags.learn ? "POLARIS-LEARN-IT" : "automatic-success",
    sourceSessionId: sessionId,
  };
}

async function summarizeWithCheapModel(record, sessionId, triggerFlags) {
  const model = process.env.POLARIS_LESSON_SUMMARIZER_MODEL?.trim();
  const apiKey = process.env.POLARIS_LESSON_SUMMARIZER_API_KEY?.trim();
  const baseUrl = (process.env.POLARIS_LESSON_SUMMARIZER_BASE_URL || "https://api.openai.com/v1").trim().replace(/\/+$/, "");
  if (!model || !apiKey) {
    return null;
  }
  const prompt = {
    provider: record.provider ?? "unknown",
    cwd: record.cwd ?? null,
    title: record.title ?? null,
    status: record.lastStatus ?? null,
    lastError: record.lastError ?? null,
    triggerFlags,
    workspaceId,
    userProfileId,
  };
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
            "Summarize one engineering experience into a durable lesson. Return strict JSON with keys: title, summary, whenToUse, tags, confidence. Keep it concise. If there is no durable lesson, return {\"summary\": \"\", \"tags\": []}.",
        },
        {
          role: "user",
          content: JSON.stringify(prompt),
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
  const summary = String(parsed.summary || "").trim();
  if (!summary) {
    return null;
  }
  return {
    kind: "lesson",
    title: String(parsed.title || `Recovered lesson (${record.provider || "agent"})`).trim(),
    summary,
    whenToUse: String(parsed.whenToUse || "").trim(),
    tags: Array.isArray(parsed.tags) ? parsed.tags.map((tag) => String(tag)).slice(0, 8) : [],
    confidence: Number(parsed.confidence ?? (triggerFlags.learn ? 0.8 : 0.6)),
    trigger: triggerFlags.learn ? "POLARIS-LEARN-IT" : statusToAutomaticTrigger(record.lastStatus),
    sourceSessionId: sessionId,
  };
}

function statusToAutomaticTrigger(status) {
  return status === "error" ? "automatic-failure" : "automatic-success";
}

export async function buildLesson(record, sessionId, triggerFlags) {
  const status = String(record.lastStatus || "");
  const meaningful = shouldUseModelSummarizer(triggerFlags, status);
  if (!meaningful) {
    return null;
  }
  try {
    const modelLesson = await summarizeWithCheapModel(record, sessionId, triggerFlags);
    if (modelLesson) {
      return modelLesson;
    }
  } catch (error) {
    log("cheap summarizer failed; falling back to deterministic summary", error instanceof Error ? error.message : String(error));
  }
  return buildFallbackLesson(record, sessionId, triggerFlags);
}

export async function deriveAgentObservationUpdate(previousStatus, record) {
  const triggerFlags = parseTriggerFlags(record.title || "");
  const sessionId = String(record.runtimeInfo?.sessionId || record.persistence?.sessionId || record.id);
  const payload = {
    agentId: String(record.id),
    provider: record.provider ?? "unknown",
    cwd: record.cwd ?? null,
    title: record.title ?? null,
    status: record.lastStatus ?? null,
    lastError: record.lastError ?? null,
    updatedAt: record.updatedAt ?? null,
    triggers: triggerFlags,
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
  const lesson = shouldPersistLesson(triggerFlags, previousStatus, nextStatus)
    ? await buildLesson(record, sessionId, triggerFlags)
    : null;
  return { sessionId, triggerFlags, payload, events, lesson };
}

function makeArtifact(sessionId, lesson, metadata = {}) {
  const timestamp = new Date().toISOString();
  return {
    id: randomUUID(),
    workspaceId,
    userProfileId,
    kind: lesson.kind,
    scope: "workspace",
    title: lesson.title,
    content: lesson.summary,
    confidence: lesson.confidence,
    status: "active",
    sourceSessionId: sessionId,
    createdAt: timestamp,
    updatedAt: timestamp,
    metadata: {
      summary: lesson.summary,
      whenToUse: lesson.whenToUse,
      tags: lesson.tags,
      trigger: lesson.trigger,
      ...metadata,
    },
  };
}

function recordArtifact(state, sessionId, lesson, metadata) {
  const signature = `${sessionId}:${lesson.kind}:${lesson.title}`;
  if (state.artifacts[signature]) {
    return false;
  }
  const artifact = makeArtifact(sessionId, lesson, metadata);
  appendJsonl(artifactsFile, artifact);
  state.artifacts[signature] = artifact.id;
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
  if (derived.lesson) {
    recordArtifact(state, derived.sessionId, derived.lesson, {
      agentId: key,
      provider: record.provider ?? "unknown",
      status: nextStatus,
    });
  }
  state.agents[key] = {
    fingerprint,
    lastStatus: nextStatus,
    triggerFlags: derived.triggerFlags,
  };
  return true;
}

async function poll() {
  const state = loadObserverState();
  let changed = false;
  let recallRequested = false;
  for (const record of listAgentRecords()) {
    const triggerFlags = parseTriggerFlags(record.title || "");
    recallRequested ||= triggerFlags.recall;
    if (await maybeRecordAgentChange(state, record)) {
      changed = true;
    }
  }
  if (changed) {
    writeJson(stateFile, state);
  }
  const artifacts = listRuntimeArtifacts();
  await writeContextAndPatch(artifacts, { recallRequested });
}

export async function main() {
  ensureDir(evolutionRoot);
  log("starting observer", {
    paseoHome,
    evolutionRoot,
    daemonUrl,
    workspaceId,
    userProfileId,
    managerId,
    pollIntervalMs,
  });
  await writeContextAndPatch(listRuntimeArtifacts());
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
