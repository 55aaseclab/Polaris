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

let bootstrapSeed = fs.existsSync(contextFile) ? fs.readFileSync(contextFile, "utf8") : "";
let lastRenderedContext = bootstrapSeed;
let lastAppendedPrompt = "";
let paseoClient = null;
let createPaseoClient = null;

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

function listRuntimeArtifacts() {
  if (!fs.existsSync(artifactsFile)) {
    return [];
  }
  const lines = fs.readFileSync(artifactsFile, "utf8").split(/\r?\n/).filter(Boolean);
  const artifacts = [];
  for (const line of lines) {
    try {
      artifacts.push(JSON.parse(line));
    } catch {
      continue;
    }
  }
  return artifacts.filter((artifact) => artifact && artifact.status === "active");
}

function renderContext(artifacts) {
  const relevant = artifacts.slice(-8);
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
      ...relevant.map((artifact) => {
        const kind = String(artifact.kind || "artifact");
        const title = String(artifact.title || "Untitled artifact").trim() || "Untitled artifact";
        const content = String(artifact.content || "").trim() || "No content recorded.";
        return `- [${kind}] ${title}: ${content}`;
      }),
    ];
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

function writeContextAndPatch(artifacts) {
  const rendered = renderContext(artifacts);
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

function makeArtifact(sessionId, kind, title, content, metadata = {}) {
  const timestamp = new Date().toISOString();
  return {
    id: randomUUID(),
    workspaceId,
    userProfileId,
    kind,
    scope: kind === "user-preference" ? "user" : "workspace",
    title,
    content,
    confidence: kind === "discarded-observation" ? 0.1 : 0.6,
    status: kind === "discarded-observation" ? "suppressed" : "active",
    sourceSessionId: sessionId,
    createdAt: timestamp,
    updatedAt: timestamp,
    metadata,
  };
}

function recordArtifact(state, sessionId, kind, title, content, metadata) {
  const signature = `${sessionId}:${kind}:${title}`;
  if (state.artifacts[signature]) {
    return false;
  }
  const artifact = makeArtifact(sessionId, kind, title, content, metadata);
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

function maybeRecordAgentChange(state, record) {
  if (!record || typeof record !== "object" || !record.id) {
    return false;
  }
  const key = String(record.id);
  const previous = state.agents[key];
  const fingerprint = agentFingerprint(record);
  if (previous?.fingerprint === fingerprint) {
    return false;
  }
  const sessionId = String(
    record.runtimeInfo?.sessionId ||
      record.persistence?.sessionId ||
      record.id,
  );
  const payload = {
    agentId: key,
    provider: record.provider ?? "unknown",
    cwd: record.cwd ?? null,
    title: record.title ?? null,
    status: record.lastStatus ?? null,
    lastError: record.lastError ?? null,
    updatedAt: record.updatedAt ?? null,
  };
  recordEvent(sessionId, "task-output", payload);
  const previousStatus = previous?.lastStatus ?? null;
  const nextStatus = record.lastStatus ?? null;
  if (nextStatus === "running" && previousStatus !== "running") {
    recordEvent(sessionId, "task-started", payload);
  } else if (nextStatus === "error" && previousStatus !== "error") {
    recordEvent(sessionId, "task-failed", payload);
    const detail = String(record.lastError || "The manager reported an execution failure.");
    recordArtifact(
      state,
      sessionId,
      "workspace-playbook",
      `Recovered failure lesson (${record.provider || "agent"})`,
      detail,
      { agentId: key, provider: record.provider ?? "unknown", status: nextStatus },
    );
  } else if (
    previousStatus === "running" &&
    nextStatus &&
    nextStatus !== "running" &&
    nextStatus !== "error"
  ) {
    recordEvent(sessionId, "task-completed", payload);
    recordArtifact(
      state,
      sessionId,
      "workspace-playbook",
      `Recovered workflow lesson (${record.provider || "agent"})`,
      String(record.title || "A real manager run completed successfully."),
      { agentId: key, provider: record.provider ?? "unknown", status: nextStatus },
    );
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
    if (maybeRecordAgentChange(state, record)) {
      changed = true;
    }
  }
  if (changed) {
    writeJson(stateFile, state);
  }
  const artifacts = listRuntimeArtifacts();
  await writeContextAndPatch(artifacts);
}

async function main() {
  ensureDir(evolutionRoot);
  await writeContextAndPatch(listRuntimeArtifacts());
  await poll();
  setInterval(() => {
    void poll().catch((error) => {
      log("poll failed", error instanceof Error ? error.message : String(error));
    });
  }, pollIntervalMs);
}

void main().catch((error) => {
  log("observer crashed", error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
