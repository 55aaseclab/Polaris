import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { ClhError } from "./errors.js";

/** One durable session event (dsh session-log JSONL record). */
export interface SessionEventRecord {
  type: string;
  seq?: number;
  time?: number;
  /** dsh places the working directory at the session event top level. */
  cwd?: string;
  data?: Record<string, unknown>;
}

export interface SessionToolCall {
  callId: string;
  name: string;
  arguments?: string;
}

export interface SessionTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface SessionLogSummary {
  sessionPath: string;
  cwd?: string;
  permissionMode?: string;
  sandboxMode?: string;
  toolCalls: SessionToolCall[];
  tokens: SessionTokenUsage;
  turnCount: number;
  finalText?: string;
  endedReason?: string;
}

/**
 * Read one durable session log. Plain .jsonl is read directly; .jsonl.zstd is
 * decompressed through the zstd binary (POLARIS_CLH_ZSTD_BIN).
 */
export async function readSessionLog(sessionLogPath: string, zstdBin = "zstd"): Promise<SessionEventRecord[]> {
  if (sessionLogPath.endsWith(".zstd")) {
    return readZstd(sessionLogPath, zstdBin);
  }
  const content = await readFile(sessionLogPath, "utf8");
  return parseJsonl(content);
}

async function readZstd(sessionLogPath: string, zstdBin: string): Promise<SessionEventRecord[]> {
  const content = await new Promise<string>((resolve, reject) => {
    const child = spawn(zstdBin, ["-dc", sessionLogPath], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      err += String(chunk);
    });
    child.on("error", (error) => {
      reject(
        new ClhError("CLH_SESSION_LOG_UNAVAILABLE", `Failed to run zstd binary: ${zstdBin}`, {
          path: sessionLogPath,
          cause: String(error),
        }),
      );
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new ClhError("CLH_SESSION_LOG_UNAVAILABLE", `zstd exited with ${code} for ${sessionLogPath}: ${err.trim()}`, {
            path: sessionLogPath,
            exitCode: code,
          }),
        );
        return;
      }
      resolve(out);
    });
  });
  return parseJsonl(content);
}

export function parseJsonl(content: string): SessionEventRecord[] {
  const events: SessionEventRecord[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as SessionEventRecord);
    } catch {
      throw new ClhError("CLH_SESSION_LOG_UNAVAILABLE", "Session log contains a malformed JSONL line", {});
    }
  }
  return events;
}

/**
 * Summarize one session log into a wrapper receipt shape: tool calls, token
 * usage (from committed assistant/message usage disclosures), turn count, and
 * the final assistant text (text blocks only, reasoning excluded).
 */
export function summarizeSessionLog(sessionPath: string, events: SessionEventRecord[]): SessionLogSummary {
  const toolCalls: SessionToolCall[] = [];
  const tokens: SessionTokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let turnCount = 0;
  let lastAssistantText: string | undefined;
  let cwd: string | undefined;
  let permissionMode: string | undefined;
  let sandboxMode: string | undefined;
  let endedReason: string | undefined;

  for (const event of events) {
    const data = event.data ?? {};
    if (event.type === "session") {
      // dsh places cwd at the event top level.
      cwd = typeof event.cwd === "string" ? event.cwd : cwd;
      cwd = cwd ?? (typeof data["cwd"] === "string" ? (data["cwd"] as string) : cwd);
    } else if (event.type === "permission/preset") {
      permissionMode = typeof data["preset"] === "string" ? data["preset"] : permissionMode;
    } else if (event.type === "sandbox/mode") {
      sandboxMode = typeof data["mode"] === "string" ? (data["mode"] as string) : sandboxMode;
    } else if (event.type === "tool/call") {
      toolCalls.push({
        callId: String(data["callId"] ?? ""),
        name: String(data["name"] ?? ""),
        arguments: typeof data["arguments"] === "string" ? data["arguments"] : undefined,
      });
    } else if (event.type === "assistant/message") {
      const usage = readUsage(data["usage"]);
      if (usage) {
        tokens.inputTokens += usage.inputTokens;
        tokens.outputTokens += usage.outputTokens;
        tokens.totalTokens += usage.totalTokens;
      }
      const text = readTextBlocks(data["message"]);
      if (text !== undefined) lastAssistantText = text;
    } else if (event.type === "turn/end") {
      turnCount += 1;
      const reason = data["reason"];
      if (reason && typeof reason === "object" && typeof (reason as Record<string, unknown>)["kind"] === "string") {
        endedReason = (reason as Record<string, unknown>)["kind"] as string;
      }
    }
  }

  return {
    sessionPath,
    cwd,
    permissionMode,
    sandboxMode,
    toolCalls,
    tokens,
    turnCount,
    finalText: lastAssistantText,
    endedReason,
  };
}

function readUsage(value: unknown): SessionTokenUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const inputTokens = record["inputTokens"];
  const outputTokens = record["outputTokens"];
  const totalTokens = record["totalTokens"];
  if (typeof inputTokens !== "number" || typeof outputTokens !== "number") return undefined;
  return {
    inputTokens,
    outputTokens,
    totalTokens: typeof totalTokens === "number" ? totalTokens : inputTokens + outputTokens,
  };
}

function readTextBlocks(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const content = (message as Record<string, unknown>)["content"];
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const record = block as Record<string, unknown>;
    if (record["type"] === "text" && typeof record["text"] === "string") {
      parts.push(record["text"]);
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/**
 * Locate the newest session log for one cwd under a dsh sessions root:
 * `$DSH_HOME/sessions/<cwd-slug>/session-<id>/session.v4.jsonl(.zstd)`. The
 * slug convention matches dsh session-persistence (double dashes wrapped
 * around the dash-joined path segments). When the slug dir holds no match,
 * fall back to scanning all session dirs and matching the logged cwd.
 */
export function cwdSlug(cwd: string): string {
  const segments = cwd.split(path.sep).filter((segment) => segment.length > 0);
  return `--${segments.join("-")}--`;
}

export async function findNewestSessionLog(
  sessionsRoot: string,
  cwd: string,
): Promise<string | undefined> {
  const inSlug = await findNewestInDir(path.join(sessionsRoot, cwdSlug(cwd)));
  if (inSlug) return inSlug;
  return await findByLoggedCwd(sessionsRoot, cwd);
}

async function findNewestInDir(slugDir: string): Promise<string | undefined> {
  let sessionDirs: string[];
  try {
    sessionDirs = (await readdir(slugDir)).filter((name) => name.startsWith("session-"));
  } catch {
    return undefined;
  }
  return await newestLogFromDirs(slugDir, sessionDirs);
}

async function findByLoggedCwd(sessionsRoot: string, cwd: string): Promise<string | undefined> {
  let entries: string[];
  try {
    entries = (await readdir(sessionsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return undefined;
  }
  for (const dirName of entries) {
    const slugDir = path.join(sessionsRoot, dirName);
    const sessionDirs = (await readdir(slugDir).catch(() => [] as string[])).filter((name) =>
      name.startsWith("session-"),
    );
    const sorted = await newestLogDirs(slugDir, sessionDirs);
    for (const sessionDir of sorted) {
      const log = await findSessionLogIn(sessionDir);
      if (!log) continue;
      try {
        const events = await readSessionLog(log);
        const sessionEvent = events.find((event) => event.type === "session");
        const loggedCwd = sessionEvent ? sessionEvent.cwd : undefined;
        if (loggedCwd === cwd) return log;
      } catch {
        continue;
      }
    }
  }
  return undefined;
}

async function newestLogDirs(slugDir: string, sessionDirs: string[]): Promise<string[]> {
  const candidates: Array<{ dir: string; mtimeMs: number }> = [];
  for (const name of sessionDirs) {
    const dir = path.join(slugDir, name);
    try {
      const info = await stat(dir);
      candidates.push({ dir, mtimeMs: info.mtimeMs });
    } catch {
      continue;
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates.map((candidate) => candidate.dir);
}

async function newestLogFromDirs(slugDir: string, sessionDirs: string[]): Promise<string | undefined> {
  const sorted = await newestLogDirs(slugDir, sessionDirs);
  for (const dir of sorted) {
    const log = await findSessionLogIn(dir);
    if (log) return log;
  }
  return undefined;
}

async function findSessionLogIn(sessionDir: string): Promise<string | undefined> {
  try {
    const files = await readdir(sessionDir);
    const preferred = files.filter((name) => /^session\.(v\d+\.)?jsonl(\.zstd)?$/.test(name));
    if (preferred.length === 0) return undefined;
    // Newest version file wins; .zstd preferred within the same version.
    preferred.sort((a, b) => {
      const versionOf = (name: string) => Number.parseInt(name.match(/\.v(\d+)\./)?.[1] ?? "0", 10);
      const zstdOf = (name: string) => (name.endsWith(".zstd") ? 1 : 0);
      const versionDelta = versionOf(b) - versionOf(a);
      return versionDelta !== 0 ? versionDelta : zstdOf(b) - zstdOf(a);
    });
    return path.join(sessionDir, preferred[0]);
  } catch {
    return undefined;
  }
}
