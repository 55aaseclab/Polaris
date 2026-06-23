import fs from "node:fs";
import path from "node:path";
import type {
  EvolutionExecutionEvent,
  EvolutionMemoryChange,
  EvolutionMemoryEntry,
  EvolutionMemoryProviderEntry,
} from "./types.js";

export function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJsonFile(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function readJsonLines<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as T];
      } catch {
        return [];
      }
    });
}

export function appendJsonLine(filePath: string, value: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

export function readPendingMemoryChanges(filePath: string): EvolutionMemoryChange[] {
  return readJsonFile<EvolutionMemoryChange[]>(filePath, []);
}

export function writePendingMemoryChanges(filePath: string, changes: EvolutionMemoryChange[]): void {
  writeJsonFile(filePath, changes);
}

function parseHeaderValue(line: string): string | null {
  const match = /^- [^:]+:\s*(.+)$/.exec(line.trim());
  return match ? match[1] : null;
}

export function parseMemoryMarkdown(params: {
  filePath: string;
  workspaceId: string;
  userProfileId?: string;
  target: EvolutionMemoryEntry["target"];
}): EvolutionMemoryEntry[] {
  if (!fs.existsSync(params.filePath)) {
    return [];
  }
  const lines = fs.readFileSync(params.filePath, "utf8").split(/\r?\n/);
  const entries: EvolutionMemoryEntry[] = [];
  let section = "Memory";
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line.startsWith("## ")) {
      section = line.slice(3).trim();
      index += 1;
      continue;
    }
    const bullet = /^- `([^`]+)`\s+(.+?)\.$/.exec(line.trim());
    if (!bullet) {
      index += 1;
      continue;
    }
    const key = bullet[1];
    const title = bullet[2];
    let body = "";
    let source = "";
    let updatedAt = "";
    const nextLine = lines[index + 1] ?? "";
    if (nextLine.startsWith("  ")) {
      const trimmed = nextLine.trim();
      const sourceMatch = /^Source:\s*([^.]*)\.\s*Updated:\s*(.+)\.$/.exec(trimmed);
      if (sourceMatch) {
        source = sourceMatch[1].trim();
        updatedAt = sourceMatch[2].trim();
      } else {
        body = trimmed;
        const maybeMeta = (lines[index + 2] ?? "").trim();
        const metaMatch = /^Source:\s*([^.]*)\.\s*Updated:\s*(.+)\.$/.exec(maybeMeta);
        if (metaMatch) {
          source = metaMatch[1].trim();
          updatedAt = metaMatch[2].trim();
          index += 1;
        }
      }
      index += 1;
    }
    entries.push({
      id: `${params.target}:${section}:${key}`,
      workspaceId: params.workspaceId,
      userProfileId: params.userProfileId,
      target: params.target,
      section,
      key,
      title,
      body,
      confidence: 1,
      status: "active",
      sourceSessionId: source || undefined,
      createdAt: updatedAt || nowIso(),
      updatedAt: updatedAt || nowIso(),
      metadata: {},
    });
    index += 1;
  }
  return entries;
}

export function renderMemoryMarkdown(params: {
  heading: string;
  project: string;
  userProfileId: string;
  targetLabel: string;
  entries: EvolutionMemoryEntry[];
}): string {
  const bySection = new Map<string, EvolutionMemoryEntry[]>();
  for (const entry of params.entries) {
    const bucket = bySection.get(entry.section) ?? [];
    bucket.push(entry);
    bySection.set(entry.section, bucket);
  }
  const lines = [
    `# ${params.heading}`,
    "",
    `- Project: ${params.project}`,
    `- User profile: ${params.userProfileId}`,
    `- Target: ${params.targetLabel}`,
    "",
  ];
  for (const [section, entries] of bySection.entries()) {
    lines.push(`## ${section}`);
    lines.push("");
    for (const entry of entries) {
      lines.push(`- \`${entry.key}\` ${entry.title}.`);
      if (entry.body) {
        lines.push(`  ${entry.body}`);
      }
      lines.push(`  Source: ${entry.sourceSessionId ?? "manual"}. Updated: ${entry.updatedAt}.`);
    }
    lines.push("");
  }
  if (bySection.size === 0) {
    lines.push("_No durable memory entries were retrieved._");
    lines.push("");
  }
  return lines.join("\n");
}

export function listEventsForSession(filePath: string, workspaceId: string, sessionId: string): EvolutionExecutionEvent[] {
  return readJsonLines<EvolutionExecutionEvent>(filePath)
    .filter((event) => event.workspaceId === workspaceId && event.sessionId === sessionId)
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}

export function summarizeMemory(params: {
  workspaceEntries: EvolutionMemoryEntry[];
  userEntries: EvolutionMemoryEntry[];
  pendingChanges: EvolutionMemoryChange[];
}): {
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
} {
  const all = [...params.workspaceEntries, ...params.userEntries]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return {
    artifactCount: all.length,
    activeWorkspaceArtifacts: params.workspaceEntries.length,
    activeUserArtifacts: params.userEntries.length,
    latestTitles: all.slice(0, 5).map((entry) => entry.title),
    latestArtifacts: all.slice(0, 5).map((entry) => {
      const metadata = entry.metadata as Record<string, unknown>;
      const explainability = (metadata.explainability ?? {}) as Record<string, unknown>;
      const retrieval = (metadata.retrieval ?? {}) as Record<string, unknown>;
      const curator = (metadata.curator ?? {}) as Record<string, unknown>;
      return {
        title: entry.title,
        kind: entry.target,
        status: entry.status,
        whyExists: typeof explainability.existsBecause === "string" ? explainability.existsBecause : undefined,
        whyRetrieved: Array.isArray(retrieval.reasons) ? retrieval.reasons.map((reason) => String(reason)) : undefined,
        curatorAction: typeof curator.action === "string" ? curator.action : undefined,
        curatorReason: typeof curator.reason === "string" ? curator.reason : undefined,
        suppressedBecause: typeof explainability.suppressedBecause === "string" ? explainability.suppressedBecause : undefined,
      };
    }),
    pendingMemoryChanges: params.pendingChanges.filter((change) => change.status === "pending").length,
  };
}

export function readProviderMemory(filePath: string): EvolutionMemoryProviderEntry[] {
  return readJsonFile<EvolutionMemoryProviderEntry[]>(filePath, []);
}
